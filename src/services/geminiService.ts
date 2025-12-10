import type { Content, Part as SDKPart } from "@google/genai";
import { AppSettings, Part } from '../types';

/**
 * 检测端点是否为 Gemini 原生端点
 *
 * @param endpoint - API 端点 URL
 * @returns true 表示 Gemini 原生端点，false 表示 OpenAI 兼容端点
 */
const isGeminiEndpoint = (endpoint?: string): boolean => {
  if (!endpoint) return false;
  const url = endpoint.toLowerCase();
  const geminiHints = [
    'googleapis.com',
    'gemini.google.com',
    'generativelanguage.googleapis.com',
    'aiplatform.googleapis.com',
    'vertexai.googleapis.com',
  ];
  return geminiHints.some(hint => url.includes(hint));
};

/**
 * 将 Gemini Content 格式转换为 OpenAI messages 格式
 *
 * @param content - Gemini Content 对象
 * @returns OpenAI message 对象，如果内容为空则返回 null
 */
const convertContentToOpenAIMessage = (content: Content): any | null => {
  const roleMap: Record<string, string> = {
    user: 'user',
    model: 'assistant',
    system: 'system',
  };

  const role = roleMap[content.role] || 'user';
  const messageContent: any[] = [];

  for (const part of content.parts || []) {
    // 跳过思考链，不回传给 API
    if ((part as any).thought) continue;

    if (part.text !== undefined) {
      messageContent.push({ type: 'text', text: part.text });
    } else if (part.inlineData) {
      const mimeType = part.inlineData.mimeType || 'image/png';
      const data = part.inlineData.data || '';
      messageContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${data}`,
        },
      });
    }
  }

  if (messageContent.length === 0) return null;
  return { role, content: messageContent };
};

/**
 * 将 OpenAI message content 转换为内部 Part[] 格式
 *
 * @param content - OpenAI message content（可能是字符串或结构化数组）
 * @returns Part 数组
 */
const convertOpenAIContentToParts = (content: any): Part[] => {
  const parts: Part[] = [];

  const items = Array.isArray(content) ? content : [{ type: 'text', text: content }];
  for (const item of items) {
    if (item?.type === 'text' && item.text !== undefined) {
      parts.push({ text: item.text });
    } else if (item?.type === 'image_url' && item.image_url?.url) {
      const url: string = item.image_url.url;
      const match = url.match(/^data:(.*?);base64,(.*)$/);
      const mimeType = match?.[1] || 'image/png';
      const data = match?.[2] || '';
      parts.push({ inlineData: { mimeType, data } });
    }
  }

  return parts;
};

/**
 * 将 OpenAI 流式响应的 delta 合并到当前 parts 中
 * 类似 Gemini 流式响应的文本合并逻辑
 *
 * @param currentParts - 当前累积的 Part 数组
 * @param deltaContent - OpenAI delta.content
 */
const mergeOpenAIDeltaIntoParts = (currentParts: Part[], deltaContent: any): void => {
  const newParts = convertOpenAIContentToParts(deltaContent);

  for (const part of newParts) {
    if (part.text !== undefined) {
      const lastPart = currentParts[currentParts.length - 1];
      if (lastPart && lastPart.text !== undefined) {
        // 合并连续的文本块
        lastPart.text += part.text;
      } else {
        currentParts.push({ text: part.text });
      }
    } else if (part.inlineData) {
      currentParts.push(part);
    }
  }
};

/**
 * 构建 OpenAI chat completions 的请求 payload
 *
 * @param history - 历史对话记录
 * @param currentUserContent - 当前用户输入
 * @param settings - 应用设置
 * @param stream - 是否使用流式响应
 * @returns OpenAI API 请求 payload
 */
const buildOpenAIChatPayload = (
  history: Content[],
  currentUserContent: Content,
  settings: AppSettings,
  stream: boolean
): any => {
  const messages: any[] = [];

  // 转换历史记录
  for (const item of history) {
    const msg = convertContentToOpenAIMessage(item);
    if (msg) messages.push(msg);
  }

  // 添加当前用户消息
  const userMsg = convertContentToOpenAIMessage(currentUserContent);
  if (userMsg) messages.push(userMsg);

  return {
    model: settings.modelName || 'gpt-4o-mini',
    messages,
    stream,
  };
};

// Helper to construct user content
const constructUserContent = (prompt: string, images: { base64Data: string; mimeType: string }[]): Content => {
  const userParts: SDKPart[] = [];
  
  images.forEach((img) => {
    userParts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64Data,
      },
    });
  });

  if (prompt.trim()) {
    userParts.push({ text: prompt });
  }

  return {
    role: "user",
    parts: userParts,
  };
};

// Helper to format Gemini API errors
const formatGeminiError = (error: any): Error => {
  let message = "发生了未知错误，请稍后重试。";
  const errorMsg = error?.message || error?.toString() || "";

  if (errorMsg.includes("401") || errorMsg.includes("API key not valid")) {
    message = "API Key 无效或过期，请检查您的设置。";
  } else if (errorMsg.includes("403")) {
    message = "访问被拒绝。请检查您的网络连接（可能需要切换节点）或 API Key 权限。";
  } else if (errorMsg.includes("Thinking_config.include_thoughts") || errorMsg.includes("thinking is enabled")) {
    message = "当前模型不支持思考过程。请在设置中关闭“显示思考过程”，或切换到支持思考的模型。";
  } else if (errorMsg.includes("400")) {
    message = "请求参数无效 (400 Bad Request)。请检查您的设置或提示词。";
  } else if (errorMsg.includes("429")) {
    message = "请求过于频繁，请稍后再试（429 Too Many Requests）。";
  } else if (errorMsg.includes("503")) {
    message = "Gemini 服务暂时不可用，请稍后重试（503 Service Unavailable）。";
  } else if (errorMsg.includes("TypeError") || errorMsg.includes("Failed to fetch") || errorMsg.includes("NetworkError")) {
    message = "网络请求失败。可能是网络连接问题，或者请求内容过多（如图片太大、历史记录过长）。";
  } else if (errorMsg.includes("SAFETY")) {
    message = "生成的内容因安全策略被拦截。请尝试修改您的提示词。";
  } else if (errorMsg.includes("404")) {
    message = "请求的模型不存在或路径错误 (404 Not Found)。";
  } else if (errorMsg.includes("500")) {
    message = "Gemini 服务器内部错误，请稍后重试 (500 Internal Server Error)。";
  } else {
      // 保留原始错误信息以便调试，但在前面加上中文提示
      message = `请求出错: ${errorMsg}`;
  }

  const newError = new Error(message);
  (newError as any).originalError = error;
  return newError;
};

/**
 * 清理模型名称，移除可能包含的方法后缀
 * SDK会自动添加 :generateContent 或 :generateContentStream
 * 如果模型名中已包含这些后缀，会导致重复
 */
const cleanModelName = (modelName: string): string => {
  return modelName.replace(/:generateContent(Stream)?$/i, '');
};

/**
 * Markdown 图片提取结果类型
 */
interface ExtractedMarkdownImage {
  source: string;      // 完整的 markdown 图片片段（用于替换）
  url: string;         // markdown 中的原始 URL
  kind: 'remote' | 'data'; // URL 类型
  mimeType?: string;   // data URL 的 MIME 类型
  base64Data?: string; // data URL 的 base64 数据
}

/**
 * 解析 data URL 为 MIME 类型和 base64 数据
 * @param url - data URL 字符串
 * @returns 解析结果，如果不是有效的 data URL 则返回 null
 */
const parseDataUrl = (url: string): { mimeType: string; base64: string } | null => {
  // 匹配 data:[<mime>][;charset=<charset>][;base64],<data>
  // 使用 /i 标志使 data: 和 base64 不区分大小写
  const match = url.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
  if (!match) return null;

  const mimeType = match[1] || 'application/octet-stream'; // 使用更安全的默认值
  const isBase64 = !!match[2];
  const dataPart = match[3] || '';

  if (!isBase64) {
    // 非 base64 data URL（如 SVG），直接使用原始数据
    // 注意：这种情况在图片生成 API 中很少见，但为了完整性仍需处理
    return { mimeType, base64: dataPart };
  }

  // base64 编码的数据
  const cleanedData = dataPart.replace(/\s+/g, ''); // 移除所有空白字符

  // 尝试处理 URL 编码的字符（如 %2B）
  try {
    return { mimeType, base64: decodeURIComponent(cleanedData) };
  } catch {
    // 如果解码失败，使用原始数据
    return { mimeType, base64: cleanedData };
  }
};

/**
 * 从 Markdown 文本中提取图片（支持 HTTP URL 和 data URL）
 * @param text - Markdown 文本
 * @returns 提取的图片信息数组
 */
const extractMarkdownImages = (text: string): ExtractedMarkdownImage[] => {
  // 匹配 ![...](...) 格式，支持 http/https URL 和 data URL
  const regex = /!\[.*?\]\((https?:\/\/[^\s)]+|data:[^)]+)\)/g;
  const matches: ExtractedMarkdownImage[] = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    const url = match[1];
    const dataUrl = parseDataUrl(url);

    if (dataUrl) {
      // data URL
      matches.push({
        source: match[0],
        url,
        kind: 'data',
        mimeType: dataUrl.mimeType,
        base64Data: dataUrl.base64,
      });
    } else {
      // 远程 URL
      matches.push({
        source: match[0],
        url,
        kind: 'remote',
      });
    }
  }

  return matches;
};

// Helper to infer MIME type from URL extension
const inferMimeFromUrl = (url: string): string => {
  if (/\.png($|\?)/i.test(url)) return 'image/png';
  if (/\.webp($|\?)/i.test(url)) return 'image/webp';
  if (/\.gif($|\?)/i.test(url)) return 'image/gif';
  return 'image/jpeg'; // 默认
};

// Helper to append a single SDK part to app parts array
const appendSdkPart = (appParts: Part[], sdkPart: SDKPart): void => {
  const signature = (sdkPart as any).thoughtSignature;
  const isThought = !!(sdkPart as any).thought;

  // Handle Text (Thought or Regular)
  if (sdkPart.text !== undefined) {
    // Check if text contains Markdown images
    const images = extractMarkdownImages(sdkPart.text);

    if (images.length > 0) {
      // Extract images and text separately
      // 使用 reduce 移除所有匹配的 markdown 图片片段
      let remainingText = images.reduce(
        (acc, img) => acc.replace(img.source, ''),
        sdkPart.text
      ).trim();

      // Add text part if there's any remaining text (除了 <think> 标签)
      if (remainingText && !remainingText.match(/^<think>[\s\S]*<\/think>$/)) {
        appParts.push({
          text: remainingText,
          thought: isThought,
          ...(signature && { thoughtSignature: signature }),
        });
      }

      // Add image parts - 根据图片类型选择处理方式
      images.forEach(img => {
        if (img.kind === 'data') {
          // data URL - 直接使用解析后的 base64 数据
          appParts.push({
            inlineData: {
              mimeType: img.mimeType || 'image/png',
              data: img.base64Data || ''
            },
            thought: isThought,
            ...(signature && { thoughtSignature: signature }),
          });
        } else {
          // 远程 URL - 保持 URL 格式，稍后异步转换
          appParts.push({
            inlineData: {
              mimeType: inferMimeFromUrl(img.url),
              data: img.url
            },
            thought: isThought,
            ...(signature && { thoughtSignature: signature }),
          });
        }
      });
      return;
    }

    // Regular text handling (no markdown images)
    const lastPart = appParts[appParts.length - 1];

    if (
      lastPart &&
      lastPart.text !== undefined &&
      !!lastPart.thought === isThought
    ) {
      // Merge with previous text part
      lastPart.text += sdkPart.text;
      if (signature) {
        lastPart.thoughtSignature = signature;
      }
    } else {
      // Create new text part
      appParts.push({
        text: sdkPart.text,
        thought: isThought,
        ...(signature && { thoughtSignature: signature }),
      });
    }
    return;
  }

  // Handle Images
  if (sdkPart.inlineData) {
    appParts.push({
      inlineData: {
        mimeType: sdkPart.inlineData.mimeType || 'image/png',
        data: sdkPart.inlineData.data || ''
      },
      thought: isThought,
      ...(signature && { thoughtSignature: signature }),
    });
  }
};

// Helper to process SDK parts into app Parts
const processSdkParts = (sdkParts: SDKPart[]): Part[] => {
  const appParts: Part[] = [];
  sdkParts.forEach(part => appendSdkPart(appParts, part));
  return appParts;
};

export const streamGeminiResponse = async function* (
  apiKey: string,
  history: Content[],
  prompt: string,
  images: { base64Data: string; mimeType: string }[],
  settings: AppSettings,
  signal?: AbortSignal
) {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      baseUrl: settings.customEndpoint || 'https://api.ikuncode.cc',
      apiVersion: 'v1beta',
      headers: {
        'http-referer': 'https://undyinga.com',
        'x-title': 'Nano Banana Pro'
      }
    }
  });

  // Filter out thought parts from history to avoid sending thought chains back to the model
  const cleanHistory = history.map(item => {
    if (item.role === 'model') {
      return {
        ...item,
        parts: item.parts.filter(p => !p.thought)
      };
    }
    return item;
  }).filter(item => item.parts.length > 0);

  const currentUserContent = constructUserContent(prompt, images);
  const contentsPayload = [...cleanHistory, currentUserContent];

  // 清理模型名称，避免重复添加 :generateContentStream 后缀
  const cleanedModelName = cleanModelName(settings.modelName || "gemini-3-pro-image-preview");

  try {
    const responseStream = await ai.models.generateContentStream({
      model: cleanedModelName,
      contents: contentsPayload,
      config: {
        ...(settings.isPro ? {
          imageConfig: {
            imageSize: settings.resolution,
            ...(settings.aspectRatio !== 'Auto' ? { aspectRatio: settings.aspectRatio } : {}),
          },
          tools: settings.useGrounding ? [{ googleSearch: {} }] : [],
        } : {}),
        responseModalities: ["TEXT", "IMAGE"],
        ...(settings.isPro && settings.enableThinking ? {
            thinkingConfig: {
                includeThoughts: true,
            }
        } : {}),
      },
    });

    let currentParts: Part[] = [];

    for await (const chunk of responseStream) {
      if (signal?.aborted) {
        break;
      }
      const candidates = chunk.candidates;
      if (!candidates || candidates.length === 0) continue;

      const newParts = candidates[0].content?.parts || [];

      // Use appendSdkPart to handle each new part (including markdown image extraction)
      newParts.forEach(part => appendSdkPart(currentParts, part));

      yield {
        userContent: currentUserContent,
        modelParts: currentParts // Yield the accumulated parts
      };
    }

    // Post-process: extract any markdown images that accumulated during streaming
    // This handles cases where markdown syntax was split across multiple chunks
    const finalParts: Part[] = [];
    for (const part of currentParts) {
      if (part.text && !part.thought) {
        const images = extractMarkdownImages(part.text);

        if (images.length > 0) {
          // Split this text part into text + images
          // 使用 reduce 移除所有匹配的 markdown 图片片段
          let remainingText = images.reduce(
            (acc, img) => acc.replace(img.source, ''),
            part.text
          ).trim();

          if (remainingText && !remainingText.match(/^<think>[\s\S]*<\/think>$/)) {
            finalParts.push({ ...part, text: remainingText });
          }

          images.forEach(img => {
            if (img.kind === 'data') {
              // data URL - 直接使用解析后的 base64 数据
              finalParts.push({
                inlineData: {
                  mimeType: img.mimeType || 'image/png',
                  data: img.base64Data || ''
                },
                thought: false,
                ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
              });
            } else {
              // 远程 URL - 保持 URL 格式
              finalParts.push({
                inlineData: {
                  mimeType: inferMimeFromUrl(img.url),
                  data: img.url
                },
                thought: false,
                ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
              });
            }
          });
        } else {
          finalParts.push(part);
        }
      } else {
        finalParts.push(part);
      }
    }

    // If we extracted new images, yield the final result
    if (finalParts.length !== currentParts.length ||
        finalParts.some((p, i) => p !== currentParts[i])) {
      yield {
        userContent: currentUserContent,
        modelParts: finalParts
      };
    }
  } catch (error) {
    console.error("Gemini API Stream Error:", error);
    throw formatGeminiError(error);
  }
};

/**
 * 并发生成多张图片（不同提示词）
 * 注意：只支持非流式模式
 */
export const generateContentMultiPrompts = async (
  apiKey: string,
  history: Content[],
  prompts: string[],
  images: { base64Data: string; mimeType: string }[],
  settings: AppSettings,
  signal?: AbortSignal
) => {
  if (prompts.length === 0) {
    throw new Error('至少需要一个提示词');
  }

  if (prompts.length === 1) {
    return generateContent(apiKey, history, prompts[0], images, settings, signal);
  }

  // 并发生成多个不同的提示词
  // 重要：为每个提示词添加"画"前缀，确保API理解这是图片生成请求
  const promises = prompts.map((prompt, index) => {
    // 如果提示词不包含"画"、"生成"、"create"、"draw"等关键词，自动添加
    const needsPrefix = !/^(画|绘制|生成|创作|制作|draw|create|generate|make)/i.test(prompt.trim());
    const enhancedPrompt = needsPrefix ? `画${prompt}` : prompt;

    console.log(`[批量生成] 提示词 ${index + 1}:`, {
      原始: prompt,
      增强后: enhancedPrompt,
      需要前缀: needsPrefix
    });

    return generateContent(apiKey, history, enhancedPrompt, images, settings, signal).then((result) => ({
      ...result,
      prompt: enhancedPrompt, // 记录增强后的提示词
    }));
  });

  const results = await Promise.all(promises);

  console.log('[批量生成] 所有请求完成，结果数量:', results.length);
  results.forEach((result, index) => {
    const images = result.modelParts.filter((p) => p.inlineData && !p.thought);
    console.log(`[批量生成] 结果 ${index + 1}:`, {
      prompt: result.prompt,
      totalParts: result.modelParts.length,
      imageCount: images.length,
      parts: result.modelParts.map(p => ({
        hasText: !!p.text,
        hasImage: !!p.inlineData,
        isThought: !!p.thought,
      }))
    });
  });

  // 合并结果
  let mergedParts: Part[] = [];

  // 1. 保留第一个结果的思考过程（如果有）
  const firstThoughts = results[0].modelParts.filter((p) => p.thought);
  mergedParts.push(...firstThoughts);

  // 2. 收集所有图片，并标记它们的提示词
  let totalImages = 0;
  results.forEach((result) => {
    const images = result.modelParts.filter((p) => p.inlineData && !p.thought);
    images.forEach((img) => {
      mergedParts.push({
        ...img,
        prompt: result.prompt, // 标记这张图的提示词
      });
      totalImages++;
    });
  });

  console.log('[批量生成] 合并后的图片数量:', totalImages);
  console.log('[批量生成] 合并后的总 parts 数量:', mergedParts.length);

  // 3. 添加一个汇总文本
  if (totalImages > 0) {
    mergedParts.push({
      text: `已生成 ${totalImages} 张不同的图片`,
    });
  } else {
    mergedParts.push({
      text: `批量生成完成，但未检测到图片。请检查提示词或重试。`,
    });
  }

  return {
    userContent: results[0].userContent,
    modelParts: mergedParts,
  };
};

/**
 * 并发生成多张图片
 * 注意：只支持非流式模式
 */
export const generateContentBatch = async (
  apiKey: string,
  history: Content[],
  prompt: string,
  images: { base64Data: string; mimeType: string }[],
  settings: AppSettings,
  count: number,
  signal?: AbortSignal
) => {
  // 如果只生成1张，直接调用原函数
  if (count === 1) {
    return generateContent(apiKey, history, prompt, images, settings, signal);
  }

  // 并发生成多张
  const promises = Array.from({ length: count }, () =>
    generateContent(apiKey, history, prompt, images, settings, signal)
  );

  const results = await Promise.all(promises);

  // 合并结果
  let mergedParts: Part[] = [];

  // 1. 保留第一个结果的思考过程（如果有）
  const firstThoughts = results[0].modelParts.filter(p => p.thought);
  mergedParts.push(...firstThoughts);

  // 2. 收集所有非思考的文本部分（通常是图片描述）
  const allTexts = results
    .flatMap(r => r.modelParts)
    .filter(p => p.text && !p.thought)
    .map(p => p.text)
    .filter(Boolean);

  if (allTexts.length > 0) {
    // 使用第一个结果的文本（通常各个结果的文本相同或相似）
    mergedParts.push({ text: allTexts[0] });
  }

  // 3. 收集所有图片
  const allImages = results
    .flatMap(r => r.modelParts)
    .filter(p => p.inlineData && !p.thought);

  mergedParts.push(...allImages);

  return {
    userContent: results[0].userContent,
    modelParts: mergedParts
  };
};

export const generateContent = async (
  apiKey: string,
  history: Content[],
  prompt: string,
  images: { base64Data: string; mimeType: string }[],
  settings: AppSettings,
  signal?: AbortSignal
) => {
  const { GoogleGenAI } = await import("@google/genai");
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      baseUrl: settings.customEndpoint || 'https://api.ikuncode.cc',
      apiVersion: 'v1beta',
      headers: {
        'http-referer': 'https://undyinga.com',
        'x-title': 'Nano Banana Pro'
      }
    }
  });

  // Filter out thought parts from history
  const cleanHistory = history.map(item => {
    if (item.role === 'model') {
      return {
        ...item,
        parts: item.parts.filter(p => !p.thought)
      };
    }
    return item;
  }).filter(item => item.parts.length > 0);

  const currentUserContent = constructUserContent(prompt, images);
  const contentsPayload = [...cleanHistory, currentUserContent];

  // 调试：打印配置信息
  console.log('[Debug] 生成配置:', {
    isPro: settings.isPro,
    resolution: settings.resolution,
    aspectRatio: settings.aspectRatio,
    modelName: settings.modelName
  });

  // 清理模型名称，避免重复添加 :generateContent 后缀
  const cleanedModelName = cleanModelName(settings.modelName || "gemini-3-pro-image-preview");

  try {
    // If signal is aborted before we start, throw immediately
    if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }

    const response = await ai.models.generateContent({
      model: cleanedModelName,
      contents: contentsPayload,
      config: {
        ...(settings.isPro ? {
          imageConfig: {
            imageSize: settings.resolution,
            ...(settings.aspectRatio !== 'Auto' ? { aspectRatio: settings.aspectRatio } : {}),
          },
          tools: settings.useGrounding ? [{ googleSearch: {} }] : [],
        } : {}),
        responseModalities: ["TEXT", "IMAGE"],
        ...(settings.isPro && settings.enableThinking ? {
            thinkingConfig: {
                includeThoughts: true,
            }
        } : {}),
      },
    });

    if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }

    const candidate = response.candidates?.[0];
    if (!candidate || !candidate.content || !candidate.content.parts) {
      throw new Error("No content generated.");
    }

    const modelParts = processSdkParts(candidate.content.parts);

    return {
      userContent: currentUserContent,
      modelParts: modelParts
    };

  } catch (error) {
    console.error("Gemini API Error:", error);
    throw formatGeminiError(error);
  }
};
