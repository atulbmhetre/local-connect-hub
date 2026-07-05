import { toast } from "sonner";

type NetworkToastLabels = {
  retrying: string;
  failed: string;
  retryBtn: string;
};

let activeRetryToastId: string | number | null = null;

export function showNetworkRetryingToast(labels: Pick<NetworkToastLabels, "retrying">) {
  if (activeRetryToastId != null) {
    toast.loading(labels.retrying, { id: activeRetryToastId });
    return activeRetryToastId;
  }
  activeRetryToastId = toast.loading(labels.retrying);
  return activeRetryToastId;
}

export function dismissNetworkRetryingToast() {
  if (activeRetryToastId != null) {
    toast.dismiss(activeRetryToastId);
    activeRetryToastId = null;
  }
}

export function showNetworkFailedToast(
  onRetry: () => void,
  labels: Pick<NetworkToastLabels, "failed" | "retryBtn">,
) {
  dismissNetworkRetryingToast();
  toast.error(labels.failed, {
    action: {
      label: labels.retryBtn,
      onClick: onRetry,
    },
  });
}
