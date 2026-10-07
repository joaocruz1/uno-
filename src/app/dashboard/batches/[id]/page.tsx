import { notFound } from "next/navigation";
import { z } from "zod";
import { BatchDetail } from "@/components/batches/batch-detail";

export default async function BatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; if (!z.uuid().safeParse(id).success) notFound();
  return <div className="mx-auto max-w-6xl"><BatchDetail id={id}/></div>;
}
