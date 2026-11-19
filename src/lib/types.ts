export type Role = 'admin' | 'employee';
export type MemberStatus = 'active' | 'blocked' | 'deleted';

export type WeekendMode = 'sat_sun' | 'sun' | 'none';
export interface Member {
  id: string; email: string; nickname: string; role: Role; status: MemberStatus; created_at: string;
  shift_start: string | null; required_minutes: number | null; weekend_mode: WeekendMode | null;
}
export interface Schedule { shift_start: string; required: number; half: number; weekend_mode: WeekendMode; custom: boolean }

export interface Settings {
  company_name: string; timezone: string;
  required_minutes: number; half_day_minutes: number;
  weekend_mode: WeekendMode;
  annual_leave_days: number;
  shift_start: string; late_grace_minutes: number;
  geofence_enabled: boolean; office_lat: number | null; office_lng: number | null;
  geofence_radius_m: number; max_gps_accuracy_m: number;
  office_end: string; earliest_checkin: string | null; late_marks_per_half_day: number;
  reminder_hour: number; notify_admin_email: boolean; whatsapp_group_link: string; admin_whatsapp_phone: string; callmebot_apikey: string;
}

export type DayKind = 'full' | 'short' | 'half_day' | 'working' | 'missing_checkout' | 'leave' | 'half_day_leave'
  | 'holiday' | 'weekend' | 'absent' | 'not_yet';

export interface Day {
  day: string; kind: DayKind; check_in: string | null; check_out: string | null;
  worked_minutes: number | null; late: boolean; fulfilled: boolean; leave_days: number; holiday: string | null;
}

export interface Summary {
  working_days: number; present_days: number; fulfilled_days: number; unfulfilled_days: number;
  missing_checkout_days: number; late_days: number; leave_days: number; absent_days: number; total_minutes: number; late_penalty_days?: number;
}

export interface Attendance {
  id: string; member_id: string; work_date: string; check_in: string; check_out: string | null;
  in_distance_m: number | null; out_distance_m: number | null; source: 'app' | 'admin' | 'correction'; edit_reason: string | null;
}

export type LeaveType = 'casual' | 'sick' | 'earned' | 'unpaid';
export type ReqStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface LeaveRequest {
  id: string; member_id: string; start_date: string; end_date: string; leave_type: LeaveType;
  half_day: boolean; days: number; reason: string; status: ReqStatus; admin_note: string | null;
  decided_at: string | null; created_at: string;
}

export interface Correction {
  id: string; member_id: string; work_date: string; requested_check_in: string | null; requested_check_out: string | null;
  reason: string; status: Exclude<ReqStatus, 'cancelled'>; admin_note: string | null; created_at: string;
}

export interface Balance { annual: number; used: number; pending: number; remaining: number }
export interface Holiday { id: string; holiday_date: string; name: string }
export interface TeamRow { member_id: string; nickname: string; email: string; kind: DayKind; check_in: string | null; check_out: string | null; worked_minutes: number | null; late: boolean }
export interface TrendRow { day: string; present: number; full_days: number; on_leave: number; absent: number; expected: number }
export interface PunchAttempt { id: string; member_id: string; attempted_at: string; kind: 'in' | 'out'; distance_m: number | null; accuracy_m: number | null; reason: string }
export interface AuditEntry { id: number; at: string; actor: string | null; action: string; table_name: string; row_id: string | null; old_data: any; new_data: any; hash: string }
export interface AuditCheck { entries: number; broken_at: number | null; last_hash: string }
export interface GeoFix { lat: number; lng: number; accuracy: number }
export interface Notice { id: string; audience: string; kind: string; title: string; body: string; link: string; created_at: string }
export interface Boot {
  me: Member; settings: Settings; schedule: Schedule; server_time: string; today: string;
  week: Day[]; month: Summary; balance: Balance; notifications: Notice[]; upcoming_holidays: Holiday[];
  pending?: number; setup?: { people: number; holidays: number; location: boolean; whatsapp: boolean };
}
export interface HolidayCandidate { date: string; name: string; gazetted?: boolean }
export interface MemberPatch { nickname: string; role: Role; status: MemberStatus; shift_start?: string | null; required_minutes?: number | null; weekend_mode?: WeekendMode | null }

export interface Backend {
  configured: boolean;
  onAuth(cb: (signedIn: boolean) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, code: string): Promise<void>;
  signOut(): Promise<void>;
  bootstrap(): Promise<Boot | null>;
  serverTime(): Promise<string>;
  notifications(): Promise<Notice[]>;

  punch(kind: 'in' | 'out', fix: GeoFix | null): Promise<{ ok: boolean; error?: string }>;
  days(member: string, from: string, to: string): Promise<Day[]>;
  summary(member: string, from: string, to: string): Promise<Summary>;
  balance(member?: string, year?: number): Promise<Balance>;
  leaves(member?: string): Promise<LeaveRequest[]>;
  requestLeave(start: string, end: string, type: LeaveType, half: boolean, reason: string): Promise<void>;
  cancelLeave(id: string): Promise<void>;
  corrections(member?: string): Promise<Correction[]>;
  requestCorrection(date: string, inTime: string | null, outTime: string | null, reason: string): Promise<void>;
  holidays(): Promise<Holiday[]>;

  members(): Promise<Member[]>;
  addMember(email: string, nickname: string, role: Role): Promise<string | null>;
  resetCode(id: string): Promise<string>;
  updateMember(id: string, p: MemberPatch): Promise<void>;
  teamDay(day?: string): Promise<TeamRow[]>;
  teamTrend(from: string, to: string): Promise<TrendRow[]>;
  attendance(member: string, from: string, to: string): Promise<Attendance[]>;
  setAttendance(member: string, date: string, inTime: string | null, outTime: string | null, reason: string): Promise<void>;
  deleteAttendance(id: string, reason: string): Promise<void>;
  decideLeave(id: string, approve: boolean, note: string): Promise<void>;
  decideCorrection(id: string, approve: boolean, note: string): Promise<void>;
  addHoliday(date: string, name: string): Promise<void>;
  addHolidays(items: HolidayCandidate[]): Promise<{ added: number; skipped: string[] }>;
  publicHolidays(year: number): Promise<HolidayCandidate[]>;
  readHolidayFile(file: File, year: number): Promise<HolidayCandidate[]>;
  sendTestAlert(): Promise<{ email: number; whatsapp: boolean }>;
  deleteHoliday(id: string): Promise<void>;
  saveSettings(s: Partial<Settings>): Promise<void>;
  verifyAudit(): Promise<AuditCheck>;
  auditLog(limit: number): Promise<AuditEntry[]>;
  punchAttempts(limit: number): Promise<PunchAttempt[]>;
}
