import nodemailer from "nodemailer";
import { Resend } from "resend";

type AuthEmailMessage = {
  to: string;
  name: string;
  url: string;
};

export type AuthMailer = {
  sendVerification(message: AuthEmailMessage): Promise<void>;
  sendPasswordReset(message: AuthEmailMessage): Promise<void>;
};

type MailPayload = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function renderMessage(kind: "verification" | "reset", message: AuthEmailMessage): MailPayload {
  const safeName = escapeHtml(message.name);
  const safeUrl = escapeHtml(message.url);
  const verification = kind === "verification";
  const subject = verification ? "Confirme seu e-mail na UNO" : "Redefina sua senha da UNO";
  const action = verification ? "Confirmar e-mail" : "Redefinir senha";
  const introduction = verification
    ? "Confirme seu endereço de e-mail para ativar sua conta."
    : "Recebemos uma solicitação para redefinir sua senha.";

  return {
    to: message.to,
    subject,
    text: `Olá, ${message.name}. ${introduction}\n\n${message.url}\n\nSe você não fez esta solicitação, ignore esta mensagem.`,
    html: `<div style="font-family:Arial,sans-serif;background:#050505;color:#fff;padding:32px"><div style="max-width:560px;margin:auto"><p style="color:#ef233c;font-weight:700">UNO</p><h1 style="font-size:24px">Olá, ${safeName}.</h1><p style="color:#d4d4d8;line-height:1.6">${introduction}</p><p style="margin:28px 0"><a href="${safeUrl}" style="display:inline-block;background:#ef233c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">${action}</a></p><p style="color:#71717a;font-size:13px">Se você não fez esta solicitação, ignore esta mensagem.</p></div></div>`,
  };
}

function emailFrom(): string {
  return process.env.EMAIL_FROM?.trim() || "UNO <no-reply@example.com>";
}

export function createAuthMailer(): AuthMailer {
  const smtpUrl = process.env.SMTP_URL?.trim();
  const useLocalSmtp = process.env.NODE_ENV !== "production" && Boolean(smtpUrl);

  if (useLocalSmtp) {
    const transport = nodemailer.createTransport(smtpUrl as string);
    const send = async (payload: MailPayload) => {
      try {
        await transport.sendMail({ from: emailFrom(), ...payload });
      } catch {
        throw new Error("Authentication email delivery failed");
      }
    };
    return {
      sendVerification: (message) => send(renderMessage("verification", message)),
      sendPasswordReset: (message) => send(renderMessage("reset", message)),
    };
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("Resend is required for authentication email delivery");
  const resend = new Resend(apiKey);
  const send = async (payload: MailPayload) => {
    const { error } = await resend.emails.send({ from: emailFrom(), ...payload });
    if (error) throw new Error("Authentication email delivery failed");
  };

  return {
    sendVerification: (message) => send(renderMessage("verification", message)),
    sendPasswordReset: (message) => send(renderMessage("reset", message)),
  };
}

export type InvitationEmailMessage = {
  to: string;
  organizationName: string;
  inviterName: string;
  roleLabel: string;
  url: string;
  expiresAt: Date;
};

export type InvitationMailer = {
  sendOrganizationInvitation(message: InvitationEmailMessage): Promise<void>;
};

function renderInvitation(message: InvitationEmailMessage): MailPayload {
  const organization = escapeHtml(message.organizationName);
  const inviter = escapeHtml(message.inviterName);
  const role = escapeHtml(message.roleLabel);
  const safeUrl = escapeHtml(message.url);
  const deadline = message.expiresAt.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const introduction = `${message.inviterName} convidou você para participar de ${message.organizationName} na UNO como ${message.roleLabel}.`;
  return {
    to: message.to,
    subject: "Convite para uma organização na UNO",
    text: `${introduction}\n\nAceite até ${deadline}:\n${message.url}\n\nO convite vale para este endereço de e-mail e só pode ser usado uma vez. Se você não esperava esta mensagem, ignore-a.`,
    html: `<div style="font-family:Arial,sans-serif;background:#050505;color:#fff;padding:32px"><div style="max-width:560px;margin:auto"><p style="color:#ef233c;font-weight:700">UNO</p><h1 style="font-size:24px">Você recebeu um convite.</h1><p style="color:#d4d4d8;line-height:1.6">${inviter} convidou você para participar de <strong>${organization}</strong> como ${role}.</p><p style="margin:28px 0"><a href="${safeUrl}" style="display:inline-block;background:#ef233c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700">Aceitar convite</a></p><p style="color:#71717a;font-size:13px">Válido até ${escapeHtml(deadline)}, para este endereço de e-mail e para um único uso. Se você não esperava esta mensagem, ignore-a.</p></div></div>`,
  };
}

/** Invitation delivery through the same provider selection as authentication mail. */
export function createInvitationMailer(): InvitationMailer {
  const smtpUrl = process.env.SMTP_URL?.trim();
  if (process.env.NODE_ENV !== "production" && smtpUrl) {
    const transport = nodemailer.createTransport(smtpUrl);
    return {
      async sendOrganizationInvitation(message) {
        try {
          await transport.sendMail({ from: emailFrom(), ...renderInvitation(message) });
        } catch {
          throw new Error("Invitation email delivery failed");
        }
      },
    };
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("Resend is required for invitation email delivery");
  const resend = new Resend(apiKey);
  return {
    async sendOrganizationInvitation(message) {
      const { error } = await resend.emails.send({ from: emailFrom(), ...renderInvitation(message) });
      if (error) throw new Error("Invitation email delivery failed");
    },
  };
}
