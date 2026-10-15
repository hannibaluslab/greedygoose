import { notFound } from "next/navigation";
import { SendDoneDemo } from "./SendDoneDemo";

/** Dev-only: Send's done state, which the dev preview can't reach (JAW doesn't sign there). A 404 in production builds. */
export default function DevSendPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SendDoneDemo />;
}
