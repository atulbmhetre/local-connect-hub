import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { setAppNavigate, clearAppNavigate } from "@/lib/appNavigate";

/** Registers React Router navigate for native push tap deep-links. */
export function PushNavigationBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    setAppNavigate(navigate);
    return () => clearAppNavigate();
  }, [navigate]);

  return null;
}
