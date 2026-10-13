import { agentRoutes } from "@/lib/agent-routes";

const routes = agentRoutes("bot");
export const GET = routes.next;
