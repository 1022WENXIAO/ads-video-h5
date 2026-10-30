import { Check, ChevronDown, LoaderCircle, AlertCircle, GitBranch } from 'lucide-react';
import type { Job } from '../../../shared/types';
export default function ExecutionList({ job, retry }: { job: Job; retry: () => void }) {
  const start = job.attempts?.find((item) => item.id === job.attemptId)?.startedAt;
  const events = (job.workflow || []).filter((event) => !start || event.at >= start);
  const running = events.filter((event) => event.status === 'running').length;
  return (
    <details
      className="execution-list"
      open={job.status === 'running' || job.status === 'queued' || job.status === 'stopping'}
    >
      <summary>
        <GitBranch size={15} />
        <span>
          {job.status === 'queued'
            ? '等待执行'
            : job.status === 'stopping'
              ? '正在停止'
              : `工具执行${events.length ? ` · ${events.length} 个` : ''}`}
          {running > 1 ? ` · ${running} 个同时运行` : ''}
        </span>
        <ChevronDown size={14} />
      </summary>
      <div className="execution-rows">
        {events.map((event) => (
          <details className="execution-row" key={event.callId || `${event.tool}-${event.at}`}>
            <summary>
              {event.status === 'running' ? (
                <LoaderCircle size={15} className="spin" />
              ) : event.status === 'succeeded' ? (
                <Check size={15} />
              ) : (
                <AlertCircle size={15} />
              )}
              <span>
                {event.stage || event.tool}
                <small>{event.tool}</small>
              </span>
              <time>
                {event.status === 'running' ? '运行中' : event.status === 'succeeded' ? '已完成' : '失败'}
                {event.durationMs !== undefined ? ` · ${(event.durationMs / 1000).toFixed(1)}s` : ''}
              </time>
            </summary>
            <pre>
              {JSON.stringify({ input: event.input, output: event.output, error: event.detail }, null, 2)}
            </pre>
          </details>
        ))}
        {!events.length ? <p className="muted">{job.stage || '任务已保存，等待后台执行。'}</p> : null}
      </div>
      {job.error ? <p className="inline-error">{job.error}</p> : null}
      {job.status === 'failed' || job.status === 'cancelled' ? (
        <button className="text-button" onClick={retry}>
          重试原任务
        </button>
      ) : null}
      <footer>
        {job.attempts?.length ? `第 ${job.attempts.length} 次执行 · ` : ''}
        {job.capabilities?.toolMode === 'parallel'
          ? `只读工具最多 ${job.capabilities.maxParallel} 个并行`
          : '工具按顺序执行'}
      </footer>
    </details>
  );
}
