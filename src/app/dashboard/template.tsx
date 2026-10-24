import { PageTransition } from "@/components/page-transition";

// The dashboard layout (sidebar, header) persists; only the page content animates.
export default function DashboardTemplate({ children }: { children: React.ReactNode }) {
  return <PageTransition scope="panel">{children}</PageTransition>;
}
