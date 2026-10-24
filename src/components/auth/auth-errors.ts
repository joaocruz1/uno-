/**
 * Maps Better Auth error codes (API errors in UPPER_CASE and OAuth callback
 * `?error=` codes in lower_case) to pt-BR messages. Unknown codes never leak.
 */
export function friendlyAuthError(code?: string): string {
  switch (code?.trim().toUpperCase()) {
    case "INVALID_EMAIL_OR_PASSWORD":
    case "INVALID_PASSWORD":
    case "USER_NOT_FOUND":
      return "E-mail ou senha inválidos.";
    case "EMAIL_NOT_VERIFIED":
      return "Confirme seu e-mail antes de continuar.";
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return "Já existe uma conta com este e-mail.";
    case "PASSWORD_TOO_SHORT":
      return "A senha deve ter pelo menos 8 caracteres.";
    case "INVALID_TOKEN":
      return "Este link é inválido ou expirou.";
    case "TOO_MANY_REQUESTS":
      return "Muitas tentativas. Aguarde um pouco e tente novamente.";
    // Google returned an address that already has a password account that was
    // never confirmed: Better Auth refuses to link them implicitly.
    case "ACCOUNT_NOT_LINKED":
    case "UNABLE_TO_LINK_ACCOUNT":
    case "EMAIL_DOES_NOT_MATCH":
    case "ACCOUNT_ALREADY_LINKED_TO_DIFFERENT_USER":
      return "Este e-mail já tem cadastro com senha. Entre com e-mail e senha.";
    case "ACCESS_DENIED":
      return "O login com o Google foi cancelado.";
    case "EMAIL_NOT_FOUND":
      return "O Google não informou um e-mail para esta conta.";
    case "STATE_NOT_FOUND":
    case "STATE_MISMATCH":
    case "PLEASE_RESTART_THE_PROCESS":
    case "INVALID_CODE":
    case "NO_CODE":
      return "O login com o Google expirou. Tente novamente.";
    default:
      return "Não foi possível concluir. Tente novamente.";
  }
}

/** Reads the `?error=` code the OAuth callback appends when it fails. */
export function oauthCallbackError(value: unknown): string | undefined {
  const code = Array.isArray(value) ? value[0] : value;
  if (typeof code !== "string" || !/^[A-Za-z_]{1,64}$/.test(code)) return undefined;
  return friendlyAuthError(code);
}
