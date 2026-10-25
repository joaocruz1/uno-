import { CouponManager } from "@/components/admin/coupon-manager";
import { PageHeader } from "@/components/admin/insight-ui";
import { listAdminCoupons } from "@/server/admin/coupons";
import { requireAdminPage } from "@/server/admin/page";

export const dynamic = "force-dynamic";

export default async function AdminCouponsPage() {
  const coupons = await listAdminCoupons(await requireAdminPage());
  return (
    <div>
      <PageHeader kicker="Cupons" title="Cupons de desconto" description="Cupons usados no pagamento dos planos. Cada um vira um código promocional na Stripe. Usos contam os pagamentos concluídos com o cupom aplicado; assinaturas, as organizações que estão com ele agora." />
      <div className="mt-8">
        <CouponManager coupons={coupons} />
      </div>
    </div>
  );
}
