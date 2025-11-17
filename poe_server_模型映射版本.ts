// deno run --allow-net --allow-read openai_proxy.ts
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const UPSTREAM_API = "https://api.poe.com/v1/chat/completions";

// 配置对象，包含模型映射、额外参数列表和模型默认参数
let config: {
  modelMapping: Record<string, string>;
  extraBodyParams: string[];
  modelDefaultParams: Record<string, Record<string, any>>;
} = { modelMapping: {}, extraBodyParams: [], modelDefaultParams: {} };

// 加载配置文件
async function loadConfig() {
  try {
    const configText = await Deno.readTextFile("config.json");
    const loadedConfig = JSON.parse(configText);
    
    // 加载各项配置，提供默认值防止配置缺失
    config.modelMapping = loadedConfig.modelMapping || {};
    config.extraBodyParams = loadedConfig.extraBodyParams || [];
    config.modelDefaultParams = loadedConfig.modelDefaultParams || {};
    
    console.log(`已加载 ${Object.keys(config.modelMapping).length} 个模型映射`);
    console.log(`已加载 ${config.extraBodyParams.length} 个额外参数:`, config.extraBodyParams);
    console.log(`已加载 ${Object.keys(config.modelDefaultParams).length} 个模型的默认参数`);
  } catch {
    console.warn("无法加载 config.json，将使用空映射");
    config = { modelMapping: {}, extraBodyParams: [], modelDefaultParams: {} };
  }
}

// 工具函数
const getToken = (req: Request) => req.headers.get("authorization")?.replace("Bearer ", "");
const mapModel = (model: string) => config.modelMapping[model] || model;
const jsonResponse = (data: any, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 
    "content-type": "application/json",
    "access-control-allow-origin": "*" 
  }
});

// OpenAI 标准参数列表
const STANDARD_PARAMS = [
  'model', 'messages', 'max_tokens', 'max_completion_tokens', 'stream', 
  'stream_options', 'top_p', 'stop', 'temperature', 'n', 
  'presence_penalty', 'frequency_penalty', 'logit_bias', 'user', 
  'functions', 'function_call', 'tools', 'tool_choice', 
  'response_format', 'seed', 'prompt', 'size', 'quality', 'style'
];

// 过滤支持的参数并自动转换 extra_body
function filterRequestBody(body: any) {
  const result: any = {
    model: mapModel(body.model),
    messages: body.messages,
  };

  // 处理标准参数
  for (const param of STANDARD_PARAMS) {
    if (param === 'model' || param === 'messages') continue; // 已处理
    
    if (body[param] !== undefined) {
      if (param === 'temperature') {
        result[param] = Math.min(Math.max(body[param], 0), 2);
      } else {
        result[param] = body[param];
      }
    }
  }
  
  // 收集 extraBodyParams 中的参数到 extra_body
  const extraBody: any = {};
  for (const param of config.extraBodyParams) {
    if (body[param] !== undefined) {
      extraBody[param] = body[param];
    }
  }
  
  // 如果用户已经提供了 extra_body，需要合并
  if (body.extra_body && typeof body.extra_body === 'object') {
    Object.assign(extraBody, body.extra_body);
  }
  
  // 应用模型默认参数
  const originalModel = body.model;
  if (originalModel && config.modelDefaultParams?.[originalModel]) {
    const defaults = config.modelDefaultParams[originalModel];
    for (const [param, defaultValue] of Object.entries(defaults)) {
      // 检查用户是否已传入该参数（直接传入或已在 extra_body 中）
      const isSetInBody = body[param] !== undefined;
      const isSetInExtraBody = extraBody[param] !== undefined;
      
      if (!isSetInBody && !isSetInExtraBody) {
        // 参数未设置，应用默认值
        if (config.extraBodyParams.includes(param)) {
          // 如果是 extraBodyParam，放入 extraBody
          extraBody[param] = defaultValue;
        } else {
          // 否则直接放入 result
          result[param] = defaultValue;
        }
      }
    }
  }
  
  // 如果有额外的参数，添加到 extra_body
  if (Object.keys(extraBody).length > 0) {
    result.extra_body = extraBody;
  }
  
  // 过滤 undefined 值
  return Object.fromEntries(Object.entries(result).filter(([_, v]) => v !== undefined));
}

// 处理DALL-E-3图片生成
async function handleImageGeneration(req: Request) {
  console.log("🖼️ [IMAGE GENERATION] 进入图片生成处理函数");
  
  const token = getToken(req);
  if (!token) return jsonResponse({ error: { message: "Missing Bearer token" } }, 401);

  const reqBody = await req.json();
  console.log("🖼️ [IMAGE GENERATION] 请求体:", JSON.stringify(reqBody, null, 2));
  
  // 检查尺寸参数
  const size = reqBody.size || "1024x1024";
  let aspect: string | undefined;
  
  // 根据尺寸设置 aspect 参数（保持原有逻辑不变）
  if (size === "1024x1024") {
    // 默认尺寸，不需要 aspect 参数
    aspect = undefined;
    console.log("尺寸 1024x1024: 不需要 aspect 参数");
  } else if (size === "1792x1024") {
    aspect = "7:4";
    console.log(`尺寸 1792x1024: 设置 aspect 参数为 ${aspect}`);
  } else if (size === "1024x1792") {
    aspect = "4:7";
    console.log(`尺寸 1024x1792: 设置 aspect 参数为 ${aspect}`);
  } else {
    // 不支持的尺寸
    console.log(`拒绝请求: 尺寸 ${size} 不被支持`);
    return jsonResponse({ 
      error: { 
        message: `Invalid size: ${size}. Supported sizes are: 1024x1024, 1792x1024, 1024x1792.`,
        type: "invalid_request_error",
        param: "size",
        code: "invalid_size"
      } 
    }, 400);
  }
  
  // 确保尺寸为 1024x1024（因为 Poe API 只支持这个尺寸，aspect 参数控制实际比例）
  const upstreamSize = "1024x1024";
  
  console.log(`🖼️ [IMAGE GENERATION] 处理图片生成请求: 用户尺寸=${size}, 上游尺寸=${upstreamSize}, aspect=${aspect}, prompt="${reqBody.prompt}"`);
  
  // 构建请求体，将 aspect 作为非标准参数传递
  // filterRequestBody 会自动将 aspect 放入 extra_body
  const requestParams: any = {
    model: "dall-e-3",
    messages: [{ role: "user", content: reqBody.prompt }],
    max_tokens: 1000,
    size: upstreamSize, // Poe 只支持 1024x1024
    quality: reqBody.quality,
    style: reqBody.style
  };
  
  // 如果有 aspect 参数，添加它（会被放入 extra_body）
  if (aspect) {
    requestParams.aspect = aspect;
  }
  
  // 使用 filterRequestBody 来处理参数转换
  const chatRequest = filterRequestBody(requestParams);
  console.log("🖼️ [IMAGE GENERATION] 转换后的请求:", JSON.stringify(chatRequest, null, 2));

  try {
    const response = await fetch(UPSTREAM_API, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(chatRequest)
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return jsonResponse({ 
        error: { 
          message: errorData.error?.message || "Upstream API error",
          type: getErrorType(response.status)
        } 
      }, response.status);
    }

    const chatResponse = await response.json();
    const content = chatResponse.choices?.[0]?.message?.content || "";
    const imageUrl = content.match(/https:\/\/[^\s\)]+/g)?.[0] || "";
    
    console.log("🖼️ [IMAGE GENERATION] 上游响应内容:", content);
    console.log("🖼️ [IMAGE GENERATION] 提取的图片URL:", imageUrl);
    console.log("🖼️ [IMAGE GENERATION] ✅ 准备返回固定的 revised_prompt: '成功生成图片！'");
    
    const result = {
      created: Math.floor(Date.now() / 1000),
      data: [{
        revised_prompt: "成功生成图片！",
        url: imageUrl
      }]
    };
    
    console.log("🖼️ [IMAGE GENERATION] 📤 返回结果:", JSON.stringify(result, null, 2));
    return jsonResponse(result);

  } catch (error) {
    console.error("🖼️ [IMAGE GENERATION] 上游请求失败:", error);
    return jsonResponse({ 
      error: { 
        message: "Network error or timeout",
        type: "timeout_error" 
      } 
    }, 408);
  }
}

// 处理聊天完成
async function handleChatCompletion(req: Request) {
  console.log("💬 [CHAT COMPLETION] 进入聊天完成处理函数");
  
  const token = getToken(req);
  if (!token) return jsonResponse({ error: { message: "Missing Bearer token" } }, 401);

  const reqBody = await req.json();
  const filteredBody = filterRequestBody(reqBody);

  console.log("💬 [CHAT COMPLETION] 请求模型:", reqBody.model);
  console.log("💬 [CHAT COMPLETION] 转换后的请求:", JSON.stringify(filteredBody, null, 2));

  try {
    const response = await fetch(UPSTREAM_API, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(filteredBody)
    });

    const headers: Record<string, string> = {
      "access-control-allow-origin": "*"
    };

    if (filteredBody.stream) {
      headers["content-type"] = "text/event-stream; charset=utf-8";
      headers["cache-control"] = "no-cache";
      headers["connection"] = "keep-alive";
      return new Response(response.body, { status: response.status, headers });
    } else {
      headers["content-type"] = "application/json";
      const responseText = await response.text();
      console.log("💬 [CHAT COMPLETION] 返回原始聊天响应");
      return new Response(responseText, { status: response.status, headers });
    }

  } catch {
    return jsonResponse({ 
      error: { 
        message: "Network error or timeout",
        type: "timeout_error" 
      } 
    }, 408);
  }
}

// 根据HTTP状态码映射错误类型
function getErrorType(status: number): string {
  const errorMap: Record<number, string> = {
    400: "invalid_request_error",
    401: "authentication_error", 
    402: "insufficient_credits",
    403: "moderation_error",
    404: "not_found_error",
    408: "timeout_error",
    413: "request_too_large",
    429: "rate_limit_error",
    502: "upstream_error",
    529: "overloaded_error"
  };
  return errorMap[status] || "unknown_error";
}

// 主处理函数
async function handle(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  console.log(`📥 收到请求: ${req.method} ${pathname}`);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type"
      }
     });
  }

  if (req.method === "POST") {
    if (pathname === "/v1/images/generations") {
      console.log("🎯 路由匹配: 图片生成端点");
      return handleImageGeneration(req);
    }
    if (pathname === "/v1/chat/completions") {
      console.log("🎯 路由匹配: 聊天完成端点");
      return handleChatCompletion(req);
    }
  }

  if (req.method === "GET" && pathname === "/v1/models") {
    const models = [...Object.keys(config.modelMapping), "dall-e-3"];
    return jsonResponse({
      object: "list",
      data: models.map(model => ({
        id: model,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "proxy"
      }))
    });
  }

  console.log("❌ 未匹配到任何路由");
  return jsonResponse({
    message: "OpenAI兼容代理服务",
    endpoints: ["/v1/chat/completions", "/v1/images/generations", "/v1/models"]
  });
}

await loadConfig();
serve(handle, { port: 8000 });
console.log("🚀 服务已启动: http://localhost:8000");
