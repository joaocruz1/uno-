import type { Metadata } from "next";
import { LegalContact, PublicPage } from "@/components";

export const metadata: Metadata = { title: "Privacidade", description: "Informações operacionais sobre privacidade e tratamento de dados na UNO." };

export default function PrivacyPage() {
  return (
    <PublicPage eyebrow="Privacidade" title="Como os dados percorrem a UNO." intro="Esta página descreve o comportamento operacional previsto para documentos, contas e telemetria. O texto deve passar por revisão jurídica e receber os dados formais do operador antes da publicação comercial.">
      <article className="page-shell max-w-3xl py-20 text-sm leading-7 text-zinc-400">
        <div className="mb-12 border border-amber-400/20 bg-amber-400/[.05] p-5 text-amber-100"><b>Documento operacional.</b> Razão social, endereço, jurisdição e identificação do controlador devem ser preenchidos na configuração de implantação e aprovados por assessoria jurídica.</div>
        <div className="legal-copy">
          <h2>1. Dados tratados</h2><p>A UNO trata dados de conta, organização, assinatura, uso, chaves e configurações necessárias para prestar o serviço. Os PDFs enviados podem conter dados pessoais, logísticos e fiscais definidos por quem realiza o upload.</p>
          <h2>2. Finalidades</h2><p>Os dados são usados para autenticar pessoas, autorizar organizações, processar documentos, contabilizar cota, entregar resultados, cobrar assinaturas, operar integrações, prevenir abuso e diagnosticar falhas.</p>
          <h2>3. Documentos e conteúdo</h2><p>Arquivos de entrada e saída são armazenados de forma privada. Downloads usam URLs assinadas com expiração. O conteúdo dos documentos e valores pessoais ou fiscais extraídos não devem ser enviados a logs, análise de produto ou monitoramento de erros.</p>
          <h2>4. Retenção</h2><p>Artefatos de conversão seguem o plano ativo: 7 dias no Free, 30 no Starter, 90 no Pro e 180 no Business. Registros de conta, faturamento, segurança e auditoria podem seguir prazos distintos conforme obrigação operacional ou legal aplicável.</p>
          <h2>5. Prestadores</h2><p>A operação prevista usa provedores de hospedagem, processamento, banco de dados, fila, armazenamento de objetos, autenticação, pagamento, e-mail, análise e monitoramento. A relação efetiva de subprocessadores deve refletir os serviços configurados no ambiente de produção.</p>
          <h2>6. Segurança e acesso</h2><p>O acesso a registros, objetos, cobrança, chaves e webhooks é limitado por organização. Chaves de API são mostradas uma vez e armazenadas apenas como hash. Credenciais e URLs permanentes de armazenamento não são expostas pela API.</p>
          <h2>7. Direitos e contato</h2><p>Solicitações de acesso, correção, eliminação ou outras questões de privacidade podem ser enviadas pelo <LegalContact />. O atendimento considera a identidade do solicitante, o papel da UNO no tratamento e as obrigações aplicáveis.</p>
          <h2>8. Alterações</h2><p>Uma versão publicada deve informar a data de vigência e registrar mudanças materiais. Este rascunho não define sozinho base legal, jurisdição, prazos regulatórios ou compromissos além do comportamento técnico descrito.</p>
        </div>
      </article>
    </PublicPage>
  );
}
