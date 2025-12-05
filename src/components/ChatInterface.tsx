import React, { useRef, useEffect, useState, Suspense } from 'react';
import { useAppStore } from '../store/useAppStore';
import { InputArea } from './InputArea';
import { ErrorBoundary } from './ErrorBoundary';
import { streamGeminiResponse, generateContent, generateContentBatch } from '../services/geminiService';
import { convertMessagesToHistory } from '../utils/messageUtils';
import { ChatMessage, Attachment, Part } from '../types';
import { Sparkles } from 'lucide-react';
import { lazyWithRetry } from '../utils/lazyLoadUtils';
import { fetchImageAsBase64 } from '../utils/imageUtils';

// Lazy load components
const ThinkingIndicator = lazyWithRetry(() => import('./ThinkingIndicator').then(m => ({ default: m.ThinkingIndicator })));
const MessageBubble = lazyWithRetry(() => import('./MessageBubble').then(m => ({ default: m.MessageBubble })));

export const ChatInterface: React.FC = () => {
  const {
    apiKey,
    messages,
    settings,
    addMessage,
    updateLastMessage,
    addImageToHistory,
    isLoading,
    setLoading,
    deleteMessage,
    sliceMessages,
    fetchBalance,
    setGenerationProgress,
    resetGenerationProgress,
  } = useAppStore();

  const [showArcade, setShowArcade] = useState(false);
  const [isExiting, setIsExiting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const chunkCountRef = useRef(0);

  useEffect(() => {
    if (isLoading) {
        setShowArcade(true);
        setIsExiting(false);
    }
  }, [isLoading]);

  const handleCloseArcade = () => {
    setIsExiting(true);
    setTimeout(() => {
        setShowArcade(false);
        setIsExiting(false);
    }, 200); // Match animation duration
  };

  const handleToggleArcade = () => {
      if (showArcade && !isExiting) {
          handleCloseArcade();
      } else if (!showArcade) {
          setShowArcade(true);
      }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading, showArcade]);

  // 组件卸载时清理资源
  useEffect(() => {
    return () => {
      // 清理计时器
      if (progressTimerRef.current) {
        clearInterval(progressTimerRef.current);
      }
      // 取消进行中的请求
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      // 重置进度状态
      resetGenerationProgress();
    };
  }, [resetGenerationProgress]);

  // 清理进度计时器
  const clearProgressTimer = () => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  };

  // 启动流式进度
  const startStreamProgress = (jobId: string, messageId: string) => {
    chunkCountRef.current = 0;
    setGenerationProgress({
      jobId,
      messageId,
      mode: 'stream',
      value: 0.05,
      status: 'running',
    });
  };

  // 更新流式进度
  const updateStreamProgress = (jobId: string) => {
    const { generationProgress } = useAppStore.getState();
    if (generationProgress.jobId !== jobId) return;

    chunkCountRef.current += 1;
    // 基于chunk数量估算进度，最多到98%
    const estimated = 0.1 + Math.min(chunkCountRef.current / 50, 1) * 0.88;
    setGenerationProgress({ value: Math.min(0.98, estimated) });
  };

  // 启动非流式进度（基于时间模拟）
  const startNonStreamProgress = (jobId: string, messageId: string) => {
    clearProgressTimer();
    setGenerationProgress({
      jobId,
      messageId,
      mode: 'non-stream',
      value: 0.05,
      status: 'running',
    });

    // 使用计时器模拟进度增长，缓慢增长到90%
    progressTimerRef.current = window.setInterval(() => {
      const { generationProgress } = useAppStore.getState();
      if (generationProgress.jobId !== jobId) {
        clearProgressTimer();
        return;
      }
      // 缓慢增长，越接近90%增长越慢
      const nextValue = Math.min(0.9, generationProgress.value + (0.9 - generationProgress.value) * 0.15);
      setGenerationProgress({ value: nextValue });
    }, 400);
  };

  // 完成进度
  const finishProgress = (jobId: string, status: 'done' | 'error') => {
    const { generationProgress } = useAppStore.getState();
    if (generationProgress.jobId !== jobId) return;

    clearProgressTimer();
    setGenerationProgress({
      value: status === 'done' ? 1 : generationProgress.value,
      status,
    });

    // 成功时，短暂显示100%后重置
    if (status === 'done') {
      setTimeout(() => {
        if (useAppStore.getState().generationProgress.jobId === jobId) {
          resetGenerationProgress();
        }
      }, 600);
    }
  };

  const handleSend = async (text: string, attachments: Attachment[]) => {
    if (!apiKey) return;

    // Capture the current messages state *before* adding the new user message.
    // This allows us to generate history up to this point.
    const currentMessages = useAppStore.getState().messages;
    const history = convertMessagesToHistory(currentMessages);

    setLoading(true);
    const msgId = Date.now().toString();

    // Construct User UI Message
    const userParts: Part[] = [];
    attachments.forEach(att => {
        userParts.push({
            inlineData: {
                mimeType: att.mimeType,
                data: att.base64Data
            }
        });
    });
    if (text) userParts.push({ text });

    const userMessage: ChatMessage = {
      id: msgId,
      role: 'user',
      parts: userParts,
      timestamp: Date.now()
    };
    
    // Add User Message
    addMessage(userMessage);

    // Prepare Model Placeholder
    const modelMessageId = (Date.now() + 1).toString();
    const modelMessage: ChatMessage = {
      id: modelMessageId,
      role: 'model',
      parts: [], // Start empty
      timestamp: Date.now()
    };

    // Add Placeholder Model Message to Store
    addMessage(modelMessage);

    // 生成jobId用于追踪进度
    const jobId = `${Date.now()}`;

    try {
      // Prepare images for service
      const imagesPayload = attachments.map(a => ({
          base64Data: a.base64Data,
          mimeType: a.mimeType
      }));

      abortControllerRef.current = new AbortController();

      const startTime = Date.now();
      let thinkingDuration = 0;
      let isThinking = false;

      // 多图模式：强制使用非流式并发生成
      const shouldUseBatch = settings.imageCount > 1;
      const useStreaming = settings.streamResponse && !shouldUseBatch;

      if (useStreaming) {
          // 启动流式进度
          startStreamProgress(jobId, modelMessageId);
          const stream = streamGeminiResponse(
            apiKey,
            history,
            text,
            imagesPayload,
            settings,
            abortControllerRef.current.signal
          );

          for await (const chunk of stream) {
              // 更新流式进度
              updateStreamProgress(jobId);

              // Check if currently generating thought
              const lastPart = chunk.modelParts[chunk.modelParts.length - 1];
              if (lastPart && lastPart.thought) {
                  isThinking = true;
                  thinkingDuration = (Date.now() - startTime) / 1000;
              } else if (isThinking && lastPart && !lastPart.thought) {
                // Just finished thinking
                isThinking = false;
              }

              updateLastMessage(chunk.modelParts, false, isThinking ? thinkingDuration : undefined);
          }

          // Final update to ensure duration is set if ended while thinking (unlikely but possible)
          // or to set the final duration if the whole response was a thought
          if (isThinking) {
              thinkingDuration = (Date.now() - startTime) / 1000;
              updateLastMessage(useAppStore.getState().messages.slice(-1)[0].parts, false, thinkingDuration);
          }

          // 完成流式进度
          finishProgress(jobId, 'done');
      } else {
          // 启动非流式进度
          startNonStreamProgress(jobId, modelMessageId);

          // 使用并发生成（如果 imageCount > 1）或普通生成
          const result = shouldUseBatch
            ? await generateContentBatch(
                apiKey,
                history,
                text,
                imagesPayload,
                settings,
                settings.imageCount,
                abortControllerRef.current.signal
              )
            : await generateContent(
                apiKey,
                history,
                text,
                imagesPayload,
                settings,
                abortControllerRef.current.signal
              );

          // Calculate thinking duration for non-streaming response
          let totalDuration = (Date.now() - startTime) / 1000;
          // In non-streaming, we can't easily separate thinking time from generation time precisely
          // unless the model metadata provides it (which it currently doesn't in a standardized way exposed here).
          // But we can check if there are thinking parts and attribute some time or just show total time?
          // The UI expects thinkingDuration to show beside the "Thinking Process" block.
          // If we have thought parts, we can pass the total duration as a fallback, or 0 if we don't want to guess.
          // However, existing UI logic in MessageBubble uses `thinkingDuration` prop on the message.

          const hasThought = result.modelParts.some(p => p.thought);
          updateLastMessage(result.modelParts, false, hasThought ? totalDuration : undefined);

          // 完成非流式进度
          finishProgress(jobId, 'done');
      }

      // 收集生成的图片到历史记录
      const finalMessage = useAppStore.getState().messages.slice(-1)[0];
      if (finalMessage && finalMessage.role === 'model') {
        const imageParts = finalMessage.parts.filter(p => p.inlineData && !p.thought);

        // 使用 Promise.all 并行处理所有图片
        console.log('[图片历史] 检测到', imageParts.length, '个图片部分');

        const savePromises = imageParts.map(async (part) => {
          if (!part.inlineData) {
            console.log('[图片历史] 跳过：没有 inlineData');
            return;
          }

          let base64Data = part.inlineData.data;
          let mimeType = part.inlineData.mimeType;

          console.log('[图片历史] 处理图片:', base64Data.substring(0, 50) + '...');

          // 如果是 URL，先转换为 base64
          if (base64Data.startsWith('http://') || base64Data.startsWith('https://')) {
            try {
              console.log('[图片历史] 开始转换 URL 图片:', base64Data);
              const converted = await fetchImageAsBase64(base64Data);
              if (converted) {
                base64Data = converted.data;
                mimeType = converted.mimeType;
                console.log('[图片历史] URL 转换成功，base64 长度:', base64Data.length);
              } else {
                console.warn('[图片历史] URL 转换失败，跳过保存:', base64Data);
                return;
              }
            } catch (error) {
              console.error('[图片历史] URL 转换出错:', error);
              return;
            }
          }

          console.log('[图片历史] 准备保存图片到历史记录');
          try {
            await addImageToHistory({
              id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
              mimeType,
              base64Data,
              prompt: text || '图片生成',
              timestamp: Date.now(),
              modelName: settings.modelName,
            });
            console.log('[图片历史] ✓ 图片保存成功');
          } catch (error) {
            console.error('[图片历史] ✗ 图片保存失败:', error);
            throw error;
          }
        });

        // 等待所有图片保存完成
        try {
          await Promise.all(savePromises);
          console.log('[图片历史] ✓ 所有图片保存完成');
        } catch (err) {
          console.error('[图片历史] ✗ 保存图片过程中出错:', err);
        }
      }

    } catch (error: any) {
      if (error.name === 'AbortError' || abortControllerRef.current?.signal.aborted) {
        console.log("用户已停止生成");
        finishProgress(jobId, 'error');
        return;
      }
      console.error("生成失败", error);

      let errorText = "生成失败。请检查您的网络和 API Key。";
      if (error.message) {
          errorText = `Error: ${error.message}`;
      }

      // Update the placeholder message with error text and flag
      updateLastMessage([{ text: errorText }], true);

      // 标记进度为错误状态
      finishProgress(jobId, 'error');

    } finally {
      setLoading(false);
      abortControllerRef.current = null;
      clearProgressTimer();
      // 每次生成结束后静默刷新余额
      fetchBalance();
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };

  const handleDelete = (id: string) => {
    deleteMessage(id);
  };

  const handleRegenerate = async (id: string) => {
    if (isLoading) return;

    const index = messages.findIndex(m => m.id === id);
    if (index === -1) return;
    
    const message = messages[index];
    let targetUserMessage: ChatMessage | undefined;
    let sliceIndex = -1;

    if (message.role === 'user') {
        targetUserMessage = message;
        sliceIndex = index - 1;
    } else if (message.role === 'model') {
        // Find preceding user message
        if (index > 0 && messages[index-1].role === 'user') {
            targetUserMessage = messages[index-1];
            sliceIndex = index - 2;
        }
    }
    
    if (!targetUserMessage) return;

    // Extract content
    const textPart = targetUserMessage.parts.find(p => p.text);
    const text = textPart ? textPart.text : '';
    const imageParts = targetUserMessage.parts.filter(p => p.inlineData);
    
    const attachments: Attachment[] = imageParts.map(p => ({
        file: new File([], "placeholder"), // Dummy file object
        preview: `data:${p.inlineData!.mimeType};base64,${p.inlineData!.data}`,
        base64Data: p.inlineData!.data || '',
        mimeType: p.inlineData!.mimeType || ''
    }));

    // Slice history (delete target and future)
    sliceMessages(sliceIndex);

    // Resend
    handleSend(text || '', attachments);
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-gray-950 transition-colors duration-200">
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-6 sm:px-6 space-y-8 scroll-smooth overscroll-y-contain"
      >
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center opacity-40 select-none">
            <div className="mb-6 rounded-3xl bg-gray-50 dark:bg-gray-900 p-8 shadow-2xl ring-1 ring-gray-200 dark:ring-gray-800 transition-colors duration-200">
               <Sparkles className="h-16 w-16 text-blue-500 mb-4 mx-auto animate-pulse-fast" />
               <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Gemini 3 Pro</h3>
               <p className="max-w-xs text-sm text-gray-500 dark:text-gray-400">
                 开始输入以创建图像，通过对话编辑它们，或询问复杂的问题。
               </p>
            </div>
          </div>
        )}

        {messages.map((msg, index) => (
          <ErrorBoundary key={msg.id}>
            <Suspense fallback={<div className="h-12 w-full animate-pulse bg-gray-100 dark:bg-gray-800 rounded-lg mb-4"></div>}>
              <MessageBubble 
                message={msg} 
                isLast={index === messages.length - 1}
                isGenerating={isLoading}
                onDelete={handleDelete}
                onRegenerate={handleRegenerate}
              />
            </Suspense>
          </ErrorBoundary>
        ))}

        {showArcade && (
            <React.Suspense fallback={
                <div className="flex w-full justify-center py-6 fade-in-up">
                    <div className="w-full max-w-xl h-96 rounded-xl bg-gray-100 dark:bg-gray-900/50 animate-pulse border border-gray-200 dark:border-gray-800"></div>
                </div>
            }>
                <ThinkingIndicator 
                    isThinking={isLoading} 
                    onClose={handleCloseArcade}
                    isExiting={isExiting}
                />
            </React.Suspense>
        )}
      </div>

      <InputArea 
        onSend={handleSend} 
        onStop={handleStop} 
        disabled={isLoading}
        onOpenArcade={handleToggleArcade}
        isArcadeOpen={showArcade}
      />
    </div>
  );
};
