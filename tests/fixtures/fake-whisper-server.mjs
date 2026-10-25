#!/usr/bin/env node
import { createServer } from "node:http";
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const prefix = option("--request-path");
let requests = 0;
createServer((request, response) => {
  if (request.url === `${prefix}/health`) {
    response.end('{"status":"ok"}');
    return;
  }
  if (request.url !== `${prefix}/inference` || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    if (!body.includes('name="file"') || !body.includes("audio/wav")) {
      response.writeHead(400).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ text: `transcript ${++requests}` }));
  });
}).listen(Number(option("--port")), "127.0.0.1");
