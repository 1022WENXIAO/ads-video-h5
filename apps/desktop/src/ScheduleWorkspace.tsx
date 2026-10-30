import { useState, type FormEvent } from 'react';
import { Clock3, Plus } from 'lucide-react';
import type { DesktopState as AppState } from './types';
export default function ScheduleWorkspace({
  state,
  busy,
  mutate,
}: {
  state: AppState;
  busy: boolean;
  mutate: (path: string, method?: string, body?: unknown) => Promise<AppState>;
}) {
  const [show, setShow] = useState(false),
    [error, setError] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try {
      await action();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await run(async () => {
      await mutate('/api/schedules', 'POST', {
        sessionId: state.activeSessionId,
        title: form.get('title'),
        prompt: form.get('prompt'),
        attachmentIds: [],
        timing: { kind: 'daily', time: form.get('time'), timeZone: 'Asia/Shanghai' },
      });
      setShow(false);
    });
  }
  return (
    <section className="library-workspace">
      <div className="section-heading">
        <div>
          <h2>定时任务</h2>
          <p>浏览器关闭后，后台仍会按计划执行。</p>
        </div>
        <button className="primary" onClick={() => setShow(!show)}>
          <Plus size={15} />
          新建任务
        </button>
      </div>
      {error ? (
        <p role="alert" className="inline-error">
          {error}
        </p>
      ) : null}
      {show ? (
        <form className="schedule-create" onSubmit={create}>
          <label>
            任务名称
            <input name="title" required maxLength={80} />
          </label>
          <label>
            执行指令
            <textarea name="prompt" required maxLength={2000} />
          </label>
          <label>
            每天执行时间（北京时间）
            <input name="time" type="time" required defaultValue="09:00" />
          </label>
          <button className="primary" disabled={busy}>
            保存到当前会话
          </button>
        </form>
      ) : null}
      {(state.schedules || []).map((item) => (
        <article className="schedule-row" key={item.id}>
          <Clock3 size={19} />
          <div>
            <strong>{item.title}</strong>
            <p>{item.prompt}</p>
            <small>
              {item.status === 'active' ? '已启用' : item.status === 'paused' ? '已暂停' : '已触发'}
              {item.nextRunAt
                ? ` · 下次 ${new Date(item.nextRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
                : ''}
            </small>
          </div>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void run(() => mutate(`/api/schedules/${item.id}/run`))}
          >
            立即执行
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void run(() =>
                mutate(`/api/schedules/${item.id}`, 'PATCH', {
                  status: item.status === 'active' ? 'paused' : 'active',
                }),
              )
            }
          >
            {item.status === 'active' ? '暂停' : '恢复'}
          </button>
        </article>
      ))}
      {!state.schedules?.length ? (
        <p className="empty-list">还没有定时任务，也可以在对话中描述执行计划。</p>
      ) : null}
    </section>
  );
}
