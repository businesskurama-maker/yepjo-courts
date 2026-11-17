export type Sport = 'pickleball' | 'badminton';
export const SPORTS: Sport[] = ['pickleball', 'badminton'];
export const SPORT_LABEL: Record<Sport, string> = { pickleball: 'Pickleball', badminton: 'Badminton' };

export interface Settings {
  business_name: string;
  tagline: string;
  address: string;
  email: string;
  phone: string;
  facebook_name: string;
  facebook_url: string;
  reclub_url: string;
  slot_minutes: number;
  min_slots: number;
  max_slots: number;
  max_active_bookings: number;
  allow_cancellation: boolean;
  cancel_cutoff_hours: number;
  cancellation_note: string;
  currency: string;
  hours_confirmed: boolean;
  rates_confirmed: boolean;
  policy_confirmed: boolean;
  online_payment_enabled: boolean;
  allow_pay_at_venue: boolean;
  payment_qr_path: string | null;
  payment_instructions: string;
  payment_hold_minutes: number;
  carousel_seconds?: number;
  rewards_enabled?: boolean;
  /** Hours of court rental per 1 loyalty point (0 = off). */
  points_court_hours?: number;
  /** Pesos spent per 1 loyalty point (0 = off). */
  points_purchase_amount?: number;
  points_dance_booking?: number;
  points_event?: number;
  cancel_fee_percent?: number;
  cafe_opens?: string;
  cafe_closes?: string;
  cafe_ordering_enabled?: boolean;
  cafe_prep_minutes?: number;
}

export interface Court {
  id: number;
  sport: Sport;
  name: string;
  sort_order: number;
  is_active: boolean;
  hourly_rate: number | null;
}

export type DayType = 'weekday' | 'weekend';
export interface CourtRate {
  id?: number;
  court_id: number;
  day_type: DayType;
  starts: string; // 'HH:MM[:SS]'
  ends: string; // may be <= starts when the time set runs past midnight
  rate: number;
}

export type ClosureKind = 'closed' | 'holiday' | 'event' | 'open_play';
export interface Closure {
  id: string;
  starts_on: string; // YYYY-MM-DD (business day)
  ends_on: string;
  court_ids: number[] | null; // null = every court
  kind: ClosureKind;
  title: string;
  note: string | null;
  /** Set both to block only these hours (e.g. open play); null = the whole day. */
  start_time?: string | null;
  end_time?: string | null;
}
export const CLOSURE_LABEL: Record<ClosureKind, string> = { closed: 'Closed', holiday: 'Holiday', event: 'Special event', open_play: 'Open play' };

export interface CourtHours {
  court_id: number;
  dow: number;
  opens: string;
  closes: string;
  is_closed: boolean;
}

export interface Busy {
  court_id: number;
  starts_at: string;
  ends_at: string;
  state: 'booked' | 'blocked';
}

export type PaymentStatus = 'not_required' | 'unpaid' | 'submitted' | 'verified' | 'rejected';

/** True when the customer still has to pay (or re-send a corrected reference) before the hold runs out. */
export const awaitingPayment = (r: Pick<Reservation, 'status' | 'payment_status'>) =>
  r.status === 'pending' && (r.payment_status === 'unpaid' || r.payment_status === 'rejected');

export type ReservationKind = 'online' | 'walk_in' | 'block';

export interface Reservation {
  id: string;
  reference: string;
  court_id: number;
  user_id: string | null;
  kind: ReservationKind;
  status: 'pending' | 'confirmed' | 'cancelled';
  starts_at: string;
  ends_at: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  note: string | null;
  amount: number | null;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  payment_method?: 'venue' | 'online';
  payment_status?: PaymentStatus;
  payment_ref?: string | null;
  payment_submitted_at?: string | null;
  payment_verified_at?: string | null;
  payment_note?: string | null;
  hold_expires_at?: string | null;
  cancel_fee?: number | null;
  refund_amount?: number | null;
  refund_status?: 'none' | 'to_claim' | 'claimed';
  court?: Pick<Court, 'id' | 'name' | 'sport'> | null;
}

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  completed_at: string | null;
  /** Personal loyalty code shown as a QR on the Rewards page. */
  member_code?: string | null;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  image_path: string | null;
  image_alt: string;
  is_published: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CarouselPhoto {
  id: string;
  image_path: string;
  caption: string;
  alt_text: string;
  sort_order: number;
  is_active: boolean;
}

export interface Conversation {
  user_id: string;
  last_message_at: string;
  last_preview: string;
  user_unread: number;
  admin_unread: number;
  profile?: Pick<Profile, 'full_name' | 'email' | 'phone'> | null;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  from_admin: boolean;
  body: string;
  created_at: string;
}

export interface ActivityLog {
  id: number;
  actor_email: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  details: { label?: string | null; changed?: string[]; [k: string]: unknown };
  created_at: string;
}

// ---------------------------------------------------------------- portals
export interface CafeItem {
  id: string;
  category: string;
  name: string;
  description: string | null;
  price: number | null;
  image_path: string | null;
  is_available: boolean;
  sort_order: number;
}

export type EventKind = 'open_play' | 'training' | 'tournament' | 'other';
export const EVENT_KIND_LABEL: Record<EventKind, string> = { open_play: 'Open play', training: 'Training', tournament: 'Tournament', other: 'Event' };
export interface YepjoEvent {
  id: string;
  kind: EventKind;
  sport: Sport | 'dance' | null;
  title: string;
  description: string | null;
  image_path: string | null;
  starts_on: string;
  ends_on: string;
  start_time: string;
  end_time: string;
  price: number;
  capacity: number | null;
  is_published: boolean;
  registration_open: boolean;
}

export interface DanceSession {
  id: string;
  dance_type: string;
  instructor: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  price: number;
  step_board: boolean;
  note: string | null;
  is_published: boolean;
}

export interface Registration {
  id: string;
  reference: string;
  kind: 'event' | 'dance';
  event_id: string | null;
  dance_session_id: string | null;
  user_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  amount: number;
  status: 'pending' | 'confirmed' | 'cancelled';
  payment_method: 'free' | 'online' | 'venue';
  payment_status: PaymentStatus;
  payment_ref: string | null;
  payment_note: string | null;
  hold_expires_at: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancel_fee?: number | null;
  refund_amount?: number | null;
  refund_status?: 'none' | 'to_claim' | 'claimed';
  event?: Pick<YepjoEvent, 'id' | 'title' | 'kind' | 'starts_on' | 'ends_on' | 'start_time' | 'end_time'> | null;
  dance?: Pick<DanceSession, 'id' | 'dance_type' | 'instructor' | 'starts_at' | 'ends_at'> | null;
}

export interface Reward {
  id: string;
  title: string;
  description: string | null;
  points_cost: number;
  image_path: string | null;
  is_active: boolean;
  sort_order: number;
}

export interface PointsEntry {
  points: number;
  source: 'court' | 'dance' | 'event' | 'purchase' | 'cafe' | 'manual' | 'redeem' | 'reversal';
  note: string | null;
  created_at: string;
}

export interface CafeOrderLine { id: string; name: string; price: number; qty: number }
export type CafeOrderStatus = 'pending' | 'paid' | 'preparing' | 'ready' | 'completed' | 'cancelled';
export interface CafeOrder {
  id: string;
  reference: string;
  user_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  items: CafeOrderLine[];
  total: number;
  amount: number | null;
  pickup_at: string | null;
  note: string | null;
  status: CafeOrderStatus;
  payment_status: PaymentStatus;
  payment_ref: string | null;
  payment_note: string | null;
  hold_expires_at: string | null;
  refund_amount: number | null;
  refund_status: 'none' | 'to_claim' | 'claimed';
  created_at: string;
  cancel_reason: string | null;
}
