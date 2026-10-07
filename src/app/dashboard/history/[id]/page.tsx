import { notFound } from "next/navigation";
import { z } from "zod";
import { ConversionDetail } from "@/components/history/conversion-detail";

export default async function DetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  return <div className="mx-auto max-w-6xl"><ConversionDetail id={id}/></div>;
}
