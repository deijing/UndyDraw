import type { Content, Part as SDKPart } from "@google/genai";
import { AppSettings, Part } from '../types';

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

// Helper to extract image URLs from Markdown text
const extractMarkdownImages = (text: string): string[] => {
  const regex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  const matches = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1]);
  }
  return matches;
};

// Helper to process SDK parts into app Parts
const processSdkParts = (sdkParts: SDKPart[]): Part[] => {
  const appParts: Part[] = [];

  for (const part of sdkParts) {
    const signature = (part as any).thoughtSignature;
    const isThought = !!(part as any).thought;

    // Handle Text (Thought or Regular)
    if (part.text !== undefined) {
      // Check if text contains Markdown images
      const imageUrls = extractMarkdownImages(part.text);

      if (imageUrls.length > 0) {
        // Extract images and text separately
        let remainingText = part.text;

        // Remove markdown image syntax from text
        remainingText = remainingText.replace(/!\[.*?\]\(https?:\/\/[^\s)]+\)/g, '').trim();

        // Add text part if there's any remaining text (除了 <think> 标签)
        if (remainingText && !remainingText.match(/^<think>[\s\S]*<\/think>$/)) {
          const textPart: Part = {
            text: remainingText,
            thought: isThought
          };
          if (signature) textPart.thoughtSignature = signature;
          appParts.push(textPart);
        }

        // Add image parts - keep URLs as-is, don't convert to base64
        imageUrls.forEach(url => {
          appParts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: url // 保持 URL 格式，不转换为 base64
            },
            thought: isThought
          });
        });
      } else {
        // Regular text handling
        const lastPart = appParts[appParts.length - 1];

        if (
          lastPart &&
          lastPart.text !== undefined &&
          !!lastPart.thought === isThought
        ) {
          lastPart.text += part.text;
          if (signature) {
              lastPart.thoughtSignature = signature;
          }
        } else {
          const newPart: Part = {
            text: part.text,
            thought: isThought
          };
          if (signature) {
              newPart.thoughtSignature = signature;
          }
          appParts.push(newPart);
        }
      }
    }
    // Handle Images
    else if (part.inlineData) {
      const newPart: Part = {
        inlineData: {
            mimeType: part.inlineData.mimeType || 'image/png',
            data: part.inlineData.data || ''
        },
        thought: isThought
      };
      if (signature) {
          newPart.thoughtSignature = signature;
      }
      appParts.push(newPart);
    }
  }
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
  const ai = new GoogleGenAI(
    { apiKey, httpOptions: { baseUrl: settings.customEndpoint || 'https://undyapi.com' } }
  );

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

  try {
    const responseStream = await ai.models.generateContentStream({
      model: settings.modelName || "gemini-3-pro-image-preview",
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

      // Use the helper logic but incrementally
      // We can't reuse processSdkParts directly because we need to accumulate state (currentParts)
      // So we keep the loop logic here
      for (const part of newParts) {
        const signature = (part as any).thoughtSignature;
        const isThought = !!(part as any).thought;

        // Handle Text (Thought or Regular)
        if (part.text !== undefined) {
          const lastPart = currentParts[currentParts.length - 1];

          if (
            lastPart && 
            lastPart.text !== undefined && 
            !!lastPart.thought === isThought
          ) {
            lastPart.text += part.text;
            if (signature) {
                lastPart.thoughtSignature = signature;
            }
          } else {
            const newPart: Part = { 
              text: part.text, 
              thought: isThought 
            };
            if (signature) {
                newPart.thoughtSignature = signature;
            }
            currentParts.push(newPart);
          }
        } 
        else if (part.inlineData) {
          const newPart: Part = { 
            inlineData: {
                mimeType: part.inlineData.mimeType || 'image/png',
                data: part.inlineData.data || ''
            }, 
            thought: isThought 
          };
          if (signature) {
              newPart.thoughtSignature = signature;
          }
          currentParts.push(newPart);
        }
      }

      yield {
        userContent: currentUserContent,
        modelParts: currentParts // Yield the accumulated parts
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
  const ai = new GoogleGenAI(
    { apiKey, httpOptions: { baseUrl: settings.customEndpoint || 'https://undyapi.com' } }
  );

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

  try {
    // If signal is aborted before we start, throw immediately
    if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
    }

    const response = await ai.models.generateContent({
      model: settings.modelName || "gemini-3-pro-image-preview",
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
