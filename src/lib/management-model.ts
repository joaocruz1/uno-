import { z } from "zod";

import { planIdSchema } from "./plans";

const isoDate = z.iso.datetime({ offset: true });

export const membershipRoleSchema = z.enum(["OWNER", "ADMIN", "MEMBER"]);
export const assignableRoleSchema = z.enum(["ADMIN", "MEMBER"]);
export type MembershipRole = z.infer<typeof membershipRoleSchema>;
export type AssignableRole = z.infer<typeof assignableRoleSchema>;

export const organizationNameSchema = z.string().trim().min(2).max(80)
  .refine((value) => !/[\x00-\x1f\x7f]/u.test(value));

export const invitationEmailSchema = z.string().trim().toLowerCase().min(3).max(320).pipe(z.email());

export const organizationSummarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  role: membershipRoleSchema,
  planId: planIdSchema,
  createdAt: isoDate,
});
export const organizationListSchema = z.object({
  items: z.array(organizationSummarySchema),
  selectedOrganizationId: z.uuid().nullable(),
});

export const memberSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: membershipRoleSchema,
  joinedAt: isoDate,
});
export const memberListSchema = z.object({
  organizationId: z.uuid(),
  viewerUserId: z.uuid(),
  viewerRole: membershipRoleSchema,
  items: z.array(memberSchema),
});

export const invitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: assignableRoleSchema,
  status: z.enum(["PENDING", "EXPIRED", "ACCEPTED", "REVOKED"]),
  invitedByUserId: z.uuid().nullable(),
  expiresAt: isoDate,
  createdAt: isoDate,
});
export const invitationListSchema = z.object({ items: z.array(invitationSchema) });

export const acceptedInvitationSchema = z.object({
  organizationId: z.uuid(),
  organizationName: z.string(),
  role: membershipRoleSchema,
});

export const createOrganizationInputSchema = z.object({ name: organizationNameSchema }).strict();
export const renameOrganizationInputSchema = createOrganizationInputSchema;
export const updateMemberInputSchema = z.object({ role: assignableRoleSchema }).strict();
export const transferOwnershipInputSchema = z.object({ userId: z.uuid() }).strict();
export const createInvitationInputSchema = z.object({ email: invitationEmailSchema, role: assignableRoleSchema.default("MEMBER") }).strict();
export const acceptInvitationInputSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;
export type OrganizationList = z.infer<typeof organizationListSchema>;
export type Member = z.infer<typeof memberSchema>;
export type MemberList = z.infer<typeof memberListSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type InvitationList = z.infer<typeof invitationListSchema>;
export type AcceptedInvitation = z.infer<typeof acceptedInvitationSchema>;

export const ROLE_LABELS: Record<MembershipRole, string> = {
  OWNER: "Proprietário",
  ADMIN: "Administrador",
  MEMBER: "Membro",
};
