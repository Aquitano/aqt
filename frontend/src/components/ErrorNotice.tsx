import type { ApiResult } from "@/lib/types";

type ErrorNoticeProps<T> = {
  result: ApiResult<T>;
};

export function ErrorNotice<T>({ result }: ErrorNoticeProps<T>) {
  if (result.ok) return null;

  return (
    <div className="notice error">
      {result.status ? <strong>HTTP {result.status}: </strong> : null}
      {result.message}
    </div>
  );
}
