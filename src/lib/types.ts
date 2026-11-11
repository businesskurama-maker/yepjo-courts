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
}

export interface Court {
  id: number;
  sport: Sport;
  name: string;
  sort_order: number;
  is_active: boolean;
  hourly_rate: number | null;
}

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
  court?: Pick<Court, 'id' | 'name' | 'sport'> | null;
}

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  completed_at: string | null;
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
