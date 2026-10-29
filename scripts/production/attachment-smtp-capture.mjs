// Isolated integration-test SMTP sink. Never connects to an upstream mail server.
import { createServer as smtpServer } from 'node:net';
import { createServer as httpServer } from 'node:http';

const messages = [];
smtpServer(socket => {
  socket.setTimeout(60000,() => socket.destroy());
  socket.write('220 attachment-test SMTP ready\r\n');
  let buffer='', receiving=false, lines=[], bytes=0;
  socket.on('error',() => {});
  socket.on('data',chunk => {
    buffer+=chunk.toString();
    let end;
    while ((end=buffer.indexOf('\r\n')) >= 0) {
      const line=buffer.slice(0,end); buffer=buffer.slice(end+2);
      if (receiving) {
        if (line === '.') { messages.push(lines.join('\r\n')+'\r\n'); lines=[]; bytes=0; receiving=false; socket.write('250 2.0.0 captured\r\n'); }
        else { bytes+=line.length+2; if (bytes>32*1024*1024) return socket.destroy(); lines.push(line.startsWith('..') ? line.slice(1) : line); }
      } else if (/^EHLO |^HELO /i.test(line)) socket.write('250 attachment-test\r\n');
      else if (/^MAIL FROM:|^RCPT TO:|^RSET$/i.test(line)) socket.write('250 OK\r\n');
      else if (line === 'DATA') { receiving=true; socket.write('354 End with dot\r\n'); }
      else if (line === 'QUIT') socket.end('221 Bye\r\n');
      else socket.write('250 OK\r\n');
    }
  });
}).listen(1025,'0.0.0.0');
httpServer((request,response) => {
  const index=/^\/messages\/(\d+)\.eml$/.exec(request.url || '');
  if (index && messages[Number(index[1])]) { response.setHeader('Content-Type','message/rfc822'); response.end(messages[Number(index[1])]); }
  else if (request.url === '/messages') { response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({ count:messages.length })); }
  else { response.statusCode=404; response.end(); }
}).listen(8080,'0.0.0.0');
