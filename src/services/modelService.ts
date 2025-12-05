import { AppSettings } from '../types';

export interface ModelInfo {
  id: string;
  object: string;
  created?: number;
  owned_by?: string;
}

/**
 * 从 NewAPI 获取可用的模型列表
 * 使用 OpenAI 兼容的 /v1/models 端点
 */
export const fetchModels = async (
  apiKey: string,
  settings: AppSettings
): Promise<ModelInfo[]> => {
  const baseUrl = settings.customEndpoint || 'https://undyapi.com';

  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      throw new Error(`模型列表查询失败: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    // OpenAI 兼容的接口返回格式: { "data": [...], "object": "list" }
    if (data.data && Array.isArray(data.data)) {
      return data.data;
    }

    // 兼容其他格式
    if (Array.isArray(data)) {
      return data;
    }

    throw new Error('无法解析模型列表响应');
  } catch (error) {
    console.error('模型列表查询失败:', error);
    throw error;
  }
};
