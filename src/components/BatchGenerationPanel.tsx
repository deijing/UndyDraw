import React, { useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useUiStore } from '../store/useUiStore';
import { X, Zap, Trash2, Plus } from 'lucide-react';
import { generateContentMultiPrompts } from '../services/geminiService';
import { convertMessagesToHistory } from '../utils/messageUtils';
import { ChatMessage, Part } from '../types';

export const BatchGenerationPanel: React.FC = () => {
  const { apiKey, settings, messages, addMessage, updateLastMessage, addImageToHistory, setLoading, isLoading } = useAppStore();
  const { isBatchPanelOpen, toggleBatchPanel, addToast } = useUiStore();
  const [prompts, setPrompts] = useState<string[]>(['', '']); // 默认2个输入框

  const promptList = prompts.map(p => p.trim()).filter(p => p.length > 0);

  const handleAddPrompt = () => {
    if (prompts.length >= 16) {
      addToast('最多支持16个提示词', 'error');
      return;
    }
    setPrompts([...prompts, '']);
  };

  const handleRemovePrompt = (index: number) => {
    if (prompts.length <= 1) {
      addToast('至少保留一个输入框', 'error');
      return;
    }
    setPrompts(prompts.filter((_, i) => i !== index));
  };

  const handlePromptChange = (index: number, value: string) => {
    const newPrompts = [...prompts];
    newPrompts[index] = value;
    setPrompts(newPrompts);
  };

  const handleGenerate = async () => {
    if (!apiKey) {
      addToast('请先设置 API Key', 'error');
      return;
    }

    if (promptList.length === 0) {
      addToast('请输入至少一个提示词', 'error');
      return;
    }

    if (promptList.length > 16) {
      addToast('最多支持16个提示词', 'error');
      return;
    }

    try {
      setLoading(true);
      toggleBatchPanel(); // 关闭面板

      // 获取当前历史
      const history = convertMessagesToHistory(messages);

      // 添加用户消息（显示所有提示词）
      const msgId = Date.now().toString();
      const userText = `批量生成 ${promptList.length} 张图片：\n${promptList.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      const userMessage: ChatMessage = {
        id: msgId,
        role: 'user',
        parts: [{ text: userText }],
        timestamp: Date.now()
      };
      addMessage(userMessage);

      // 添加模型占位消息
      const modelMessageId = (Date.now() + 1).toString();
      const modelMessage: ChatMessage = {
        id: modelMessageId,
        role: 'model',
        parts: [],
        timestamp: Date.now()
      };
      addMessage(modelMessage);

      // 并发生成
      const result = await generateContentMultiPrompts(
        apiKey,
        history,
        promptList,
        [], // 批量生成不支持附件
        settings
      );

      // 更新模型消息
      updateLastMessage(result.modelParts, false);

      // 收集生成的图片到历史记录
      const imageParts = result.modelParts.filter(p => p.inlineData && !p.thought);
      imageParts.forEach(part => {
        if (part.inlineData) {
          addImageToHistory({
            id: `img-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            mimeType: part.inlineData.mimeType,
            base64Data: part.inlineData.data,
            prompt: part.prompt || '批量生成',
            timestamp: Date.now(),
            modelName: settings.modelName,
          });
        }
      });

      addToast(`成功生成 ${imageParts.length} 张图片`, 'success');
      setPrompts(['', '']); // 重置为2个空输入框

    } catch (error: any) {
      console.error('批量生成失败', error);
      const errorText = error.message || '批量生成失败，请检查网络和 API Key';
      updateLastMessage([{ text: errorText }], true);
      addToast(errorText, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleClear = () => {
    setPrompts(['', '']); // 重置为2个空输入框
  };

  if (!isBatchPanelOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
      onClick={toggleBatchPanel}
    >
      <div
        className="fixed right-0 top-0 h-full w-full sm:w-96 bg-white dark:bg-gray-950 shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-500" />
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              批量生成
            </h2>
          </div>
          <button
            onClick={toggleBatchPanel}
            className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition"
          >
            <X className="h-5 w-5 text-gray-500 dark:text-gray-400" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Info */}
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
            <p className="text-sm text-blue-700 dark:text-blue-300">
              每个输入框对应一个提示词，将同时生成多张不同的图片，大幅节省时间。
            </p>
          </div>

          {/* Prompt Inputs */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                提示词列表（默认2个）
              </label>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                <span>已输入 {promptList.length} 个</span>
                <span className={prompts.length >= 16 ? 'text-red-500 ml-1' : 'ml-1'}>
                  / 最多 16 个
                </span>
              </div>
            </div>

            <div className="space-y-2 max-h-96 overflow-y-auto">
              {prompts.map((prompt, index) => (
                <div key={index} className="flex items-center gap-2">
                  <span className="flex-shrink-0 w-6 h-6 flex items-center justify-center bg-blue-500 text-white rounded-full text-xs font-medium">
                    {index + 1}
                  </span>
                  <input
                    type="text"
                    value={prompt}
                    onChange={(e) => handlePromptChange(index, e.target.value)}
                    placeholder={`提示词 ${index + 1}（如：画一只可爱的猫）`}
                    disabled={isLoading}
                    className="flex-1 px-3 py-2 border border-gray-200 dark:border-gray-800 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500 disabled:opacity-50"
                  />
                  {prompts.length > 1 && (
                    <button
                      onClick={() => handleRemovePrompt(index)}
                      disabled={isLoading}
                      className="flex-shrink-0 p-2 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition disabled:opacity-50"
                      title="删除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Add Button */}
            {prompts.length < 16 && (
              <button
                onClick={handleAddPrompt}
                disabled={isLoading}
                className="w-full mt-3 py-2 px-4 border-2 border-dashed border-gray-300 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 rounded-lg transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Plus className="h-4 w-4" />
                <span className="text-sm font-medium">添加提示词</span>
              </button>
            )}
          </div>

          {/* Settings Info */}
          <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 space-y-1 text-xs text-gray-600 dark:text-gray-400">
            <p><strong>当前设置：</strong></p>
            <p>• 分辨率：{settings.resolution}</p>
            <p>• 长宽比：{settings.aspectRatio}</p>
            {settings.isPro && (
              <>
                <p>• Google 搜索：{settings.useGrounding ? '开启' : '关闭'}</p>
                <p>• 思考过程：{settings.enableThinking ? '开启' : '关闭'}</p>
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-800 space-y-2">
          <button
            onClick={handleGenerate}
            disabled={isLoading || promptList.length === 0 || promptList.length > 16}
            className="w-full py-3 px-4 bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 disabled:from-gray-300 disabled:to-gray-400 dark:disabled:from-gray-700 dark:disabled:to-gray-600 text-white font-medium rounded-lg transition disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <Zap className="h-4 w-4" />
            {isLoading ? '生成中...' : `生成 ${promptList.length} 张图片`}
          </button>
          <button
            onClick={handleClear}
            disabled={isLoading || prompts.length === 0}
            className="w-full py-2 px-4 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            <Trash2 className="h-4 w-4" />
            清空
          </button>
        </div>
      </div>
    </div>
  );
};
