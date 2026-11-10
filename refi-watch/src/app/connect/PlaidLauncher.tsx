"use client";

import { useEffect, useRef } from "react";
import { usePlaidLink, type PlaidLinkOnExit, type PlaidLinkOnSuccess } from "react-plaid-link";

/**
 * Mounted only once a real link token exists, so the Plaid script is never
 * loaded in test mode. Opens Plaid Link as soon as it is ready.
 * receivedRedirectUri is set only when coming back from an OAuth bank.
 */
export default function PlaidLauncher(props: { token: string; receivedRedirectUri?: string; onSuccess: PlaidLinkOnSuccess; onExit: PlaidLinkOnExit }) {
  const { open, ready, error } = usePlaidLink({
    token: props.token,
    receivedRedirectUri: props.receivedRedirectUri,
    onSuccess: props.onSuccess,
    onExit: props.onExit,
  });
  const opened = useRef(false);
  useEffect(() => {
    if (ready && !opened.current) {
      opened.current = true;
      open();
    }
  }, [ready, open]);
  if (error) return <p className="err">Plaid could not load. Check your connection and try again.</p>;
  return null;
}
