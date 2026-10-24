import { PageTransition } from "@/components/page-transition";

export default function RootTemplate({ children }: { children: React.ReactNode }) {
  return <PageTransition>{children}</PageTransition>;
}
