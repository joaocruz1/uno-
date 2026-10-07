import { getAuth } from "@/server/auth";

function handle(request: Request): Promise<Response> {
  return getAuth().handler(request);
}

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT };
