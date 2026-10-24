import type { Metadata } from "next";
import { LegalContact, PublicPage } from "@/components";

export const metadata: Metadata = { title: "Termos de uso", description: "Termos operacionais de uso do serviço UNO." };

export default function TermsPage() {
  return (
    <PublicPage eyebrow="Termos de uso" title="Regras operacionais do serviço." intro="Este texto registra o funcionamento previsto da plataforma e precisa de revisão jurídica, identificação do operador e definição de foro antes da publicação comercial.">
      <article className="page-shell max-w-3xl py-20 text-sm leading-7 text-zinc-400">
        <div className="mb-12 border border-amber-400/20 bg-amber-400/[.05] p-5 text-amber-100"><b>Rascunho para revisão.</b> Não representa aprovação jurídica nem substitui os termos finais assinados pelo operador do serviço.</div>
        <div className="legal-copy">
          <h2>1. Serviço</h2><p>A UNO recebe PDFs compatíveis e recompõe uma página de etiqueta logística com uma página de DANFE simplificada em uma saída única. O primeiro template liberado é o de Mercado Livre descrito na plataforma; outros layouts dependem de liberação específica.</p>
          <h2>2. Conta e organização</h2><p>A pessoa usuária deve fornecer dados corretos, proteger suas credenciais e usar apenas organizações e documentos para os quais tenha autorização. Ações realizadas com credenciais válidas podem ser atribuídas à respectiva conta ou organização.</p>
          <h2>3. Arquivos aceitos</h2><p>A plataforma pode recusar arquivos corrompidos, protegidos por senha, desconhecidos, ambíguos, com códigos ilegíveis ou que não caibam no formato solicitado. Quando possível, um erro de formato pequeno recomenda uma dimensão maior compatível.</p>
          <h2>4. Planos e uso</h2><p>Os planos definem quantidade mensal, tamanho máximo de arquivo, limite de lote, retenção, acesso à API e limite de requisições. Não há cobrança automática por excedente. Retentativas internas não consomem nova cota; reprocessamentos solicitados criam novo uso.</p>
          <h2>5. Assinaturas</h2><p>Assinaturas pagas são mensais e renovam automaticamente no cartão até o cancelamento. Preço, vigência e impostos são apresentados na contratação. Em Configurações → Assinatura, o proprietário ou administrador da organização pode trocar de plano (a troca vale na hora e a diferença proporcional aos dias restantes é cobrada na hora num plano maior; num plano menor a troca vale na hora, sem crédito pelos dias restantes) e cancelar (o plano continua valendo até o fim do período já pago, sem novas cobranças).</p><p>Reembolso: em até 7 dias corridos do primeiro pagamento de uma assinatura no cartão, o proprietário ou administrador pode exercer o direito de arrependimento (art. 49 do Código de Defesa do Consumidor) pelo próprio painel. O estorno é integral, inclui o adicional de API pago no mesmo período, a assinatura é encerrada na hora e a conta volta ao plano Free. O reembolso automático vale uma vez por organização. Créditos pré-pagos comprados por PIX não passam por esse fluxo automático; para eles, fale com o suporte.</p>
          <h2>6. Responsabilidades sobre o conteúdo</h2><p>A pessoa usuária continua responsável pela origem, exatidão, legalidade e impressão dos documentos. A UNO recompõe conteúdo; não emite nota fiscal, não corrige informação fiscal e não substitui validação operacional de códigos ou configuração da impressora.</p>
          <h2>7. API e webhooks</h2><p>Chaves de API são confidenciais. Integrações devem aplicar idempotência, validar assinaturas de webhook e lidar com respostas assíncronas, limites e retentativas conforme a documentação da versão usada.</p>
          <h2>8. Disponibilidade e mudanças</h2><p>Manutenções, falhas de provedores e incidentes podem afetar o serviço. Mudanças incompatíveis da API pública exigem nova versão principal. Templates podem ser suspensos quando a validação de segurança de impressão não estiver assegurada.</p>
          <h2>9. Uso indevido</h2><p>É proibido contornar limites, acessar dados de outra organização, interferir na operação, distribuir credenciais ou enviar conteúdo sem autorização. O acesso pode ser restringido para conter abuso ou risco de segurança.</p>
          <h2>10. Contato e disposições finais</h2><p>Dúvidas podem ser enviadas pelo <LegalContact />. Identificação do operador, lei aplicável, foro, garantias, limitações de responsabilidade e procedimento de notificação devem ser inseridos e aprovados antes da entrada em vigor.</p>
        </div>
      </article>
    </PublicPage>
  );
}
