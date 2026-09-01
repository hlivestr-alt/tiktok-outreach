"use client";
import { useEffect, useState } from "react";
import { Minus, Square, X } from "lucide-react";

export function DesktopTitlebar() {
  const [desktop, setDesktop] = useState(false);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const bridge = window.outreachDesktop;
    if (!bridge) return;
    setDesktop(true);
    void bridge.isMaximized().then(setMaximized);
    return bridge.onMaximizedChange(setMaximized);
  }, []);
  if (!desktop) return null;
  return <header className="desktop-titlebar" data-testid="desktop-titlebar" onDoubleClick={() => void window.outreachDesktop?.toggleMaximize()}>
    <div className="desktop-title"><span className="app-mark small" aria-hidden="true">TO</span><span>TikTok Outreach</span></div>
    <div className="window-controls" onDoubleClick={(event) => event.stopPropagation()}>
      <button type="button" aria-label="Minimize" onClick={() => void window.outreachDesktop?.minimize()}><Minus size={15}/></button>
      <button type="button" aria-label={maximized ? "Restore" : "Maximize"} onClick={async () => setMaximized(await window.outreachDesktop!.toggleMaximize())}>{maximized ? <span className="restore-icon"/> : <Square size={12}/>}</button>
      <button type="button" className="close" aria-label="Close" onClick={() => void window.outreachDesktop?.close()}><X size={15}/></button>
    </div>
  </header>;
}
