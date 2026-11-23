// Streaming speech recognition (Deepgram Nova-3 over WebSocket).
import WebSocket from 'ws';

export function createDeepgramStt({ apiKey, sampleRate, endpointingMs, keyterms = [], language = 'en-US' }) {
  /**
   * @param {{onResult:(r:{text:string,isFinal:boolean,speechFinal:boolean,fromFinalize:boolean})=>void,
   *          onUtteranceEnd:()=>void, onError:(e:Error)=>void}} handlers
   */
  return function connect(handlers) {
    const params = new URLSearchParams({
      model: 'nova-3',
      language,
      encoding: 'linear16',
      sample_rate: String(sampleRate),
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      endpointing: String(endpointingMs),
      utterance_end_ms: '1000',
      vad_events: 'true',
    });
    for (const t of keyterms.slice(0, 50)) params.append('keyterm', t);
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${apiKey}` },
    });
    let lastSend = Date.now();
    const pending = [];
    const keepAlive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN && Date.now() - lastSend > 4000) {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
        lastSend = Date.now();
      }
    }, 2000);

    ws.on('open', () => {
      for (const p of pending.splice(0)) ws.send(p);
    });
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === 'Results') {
        const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
        handlers.onResult({
          text,
          isFinal: !!msg.is_final,
          speechFinal: !!msg.speech_final,
          fromFinalize: !!msg.from_finalize,
        });
      } else if (msg.type === 'UtteranceEnd') {
        handlers.onUtteranceEnd();
      }
    });
    ws.on('error', (e) => handlers.onError(e));
    ws.on('close', (code) => {
      clearInterval(keepAlive);
      if (code !== 1000 && code !== 1005) handlers.onError(new Error(`Deepgram closed (${code})`));
    });

    const send = (data) => {
      lastSend = Date.now();
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
      else if (ws.readyState === WebSocket.CONNECTING) pending.push(data);
    };
    return {
      sendAudio: (buf) => send(buf),
      finalize: () => send(JSON.stringify({ type: 'Finalize' })),
      close: () => {
        clearInterval(keepAlive);
        try {
          send(JSON.stringify({ type: 'CloseStream' }));
          setTimeout(() => ws.close(), 500);
        } catch {}
      },
    };
  };
}
