export function LegalContact() {
  const contact = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
  return contact ? <a className="text-white underline decoration-uno-red underline-offset-4" href={`mailto:${contact}`}>{contact}</a> : <span>canal de suporte informado dentro da conta</span>;
}
