import koaBody from "koa-body";

export default koaBody({
  json: true,
  multipart: true,
  jsonLimit: "1mb",
  formLimit: "1mb",
});