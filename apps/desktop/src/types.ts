import type { AppState } from '../../../shared/types';

export interface DesktopSchedule {
  id: string;
  title: string;
  prompt: string;
  status: 'active' | 'paused' | 'completed';
  nextRunAt: string | null;
}

// Scheduling is an optional backend capability. The desktop release does not
// require publishing unrelated, pre-existing H5 scheduling UI changes.
export type DesktopState = Omit<AppState, 'schedules'> & { schedules?: DesktopSchedule[] };
