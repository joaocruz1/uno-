export type UsageReservation = {
  id: string;
  organization_id: string;
  usage_period_id: string;
  conversion_id: string;
  units: number;
  status: "RESERVED" | "CONFIRMED" | "RELEASED";
  reserved_at: Date;
  confirmed_at: Date | null;
  released_at: Date | null;
  created_at: Date;
  updated_at: Date;
};
