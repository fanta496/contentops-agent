import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateImage } = require('../ai/image-compatible.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATUlEQVR42u3PQQ0AAAgEILV/5zOFDzdoQCepz6aeExAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQELi3cqoDfaKuZM4AAAAASUVORK5CYII=', 'base64');
let audit = null;
const server = createServer(async (req, res) => {
  const chunks=[]; for await (const chunk of req) chunks.push(chunk);
  const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  audit={method:req.method,url:req.url,contentType:req.headers['content-type'],authorizationPresent:/^Bearer\s+\S+/.test(String(req.headers.authorization||'')),body};
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({created:Date.now(),data:[{b64_json:png.toString('base64')}]}));
});
await new Promise((done)=>server.listen(19994,'127.0.0.1',done));
try {
  const result=await generateImage({baseUrl:'http://127.0.0.1:19994',apiKey:'hidden-key',model:'gpt-image-2',prompt:'参考企业原图生成产品图',size:'1024x1024',inputMode:'reference_generation_json',referenceImages:[{bytes:png,mime:'image/png',name:'enterprise.png'}]});
  if(audit?.url!=='/v1/images/generations'||audit.method!=='POST'||audit.contentType!=='application/json'||!audit.authorizationPresent) throw new Error(JSON.stringify(audit));
  if(audit.body.model!=='gpt-image-2'||audit.body.prompt!=='参考企业原图生成产品图'||audit.body.n!==1||audit.body.size!=='1024x1024'||audit.body.response_format!==undefined) throw new Error(JSON.stringify(audit.body));
  if(!Array.isArray(audit.body.image)||audit.body.image.length!==1||!audit.body.image[0].startsWith('data:image/png;base64,')) throw new Error('image 数组没有携带企业图片 Data URL');
  if(!result.b64) throw new Error('返回图片未被解析');
  console.log(JSON.stringify({status:'PASS',endpoint:audit.url,contentType:audit.contentType,bodyFields:Object.keys(audit.body),imageArrayCount:audit.body.image.length,imageDataUrl:true,responseParsed:true},null,2));
} finally { server.close(); }
