import React from 'react';

interface GenerationProgressProps {
  progress: number; // 0-1
  status: 'running' | 'done' | 'error';
}

export const GenerationProgress: React.FC<GenerationProgressProps> = ({ progress, status }) => {
  const percentage = Math.min(100, Math.max(0, Math.round(progress * 100)));
  const barWidth = `${percentage}%`;

  const getStatusText = () => {
    if (status === 'error') return '生成失败';
    if (status === 'done') return '生成完成';
    return '正在生成';
  };

  const getBarColor = () => {
    if (status === 'error') return 'bg-red-500 dark:bg-red-600';
    if (status === 'done') return 'bg-gradient-to-r from-green-500 via-emerald-500 to-teal-500';
    return 'bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-600';
  };

  return (
    <div className="mt-4 w-full">
      <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-300 mb-2">
        <span className="font-medium flex items-center gap-2">
          {status === 'running' && (
            <span className="inline-block w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
          )}
          {status === 'done' && (
            <span className="inline-block w-2 h-2 bg-green-500 rounded-full" />
          )}
          {status === 'error' && (
            <span className="inline-block w-2 h-2 bg-red-500 rounded-full" />
          )}
          {getStatusText()}
        </span>
        <span className="tabular-nums font-semibold">{percentage}%</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700 shadow-inner">
        <div
          className={`h-full rounded-full transition-all duration-300 ease-out shadow-sm ${getBarColor()}`}
          style={{ width: barWidth }}
        />
      </div>
    </div>
  );
};
