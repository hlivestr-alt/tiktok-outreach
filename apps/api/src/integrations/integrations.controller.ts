import { BadRequestException, Body, Controller, Get, Param, Post, Query, Req, Res } from "@nestjs/common";
import type {FastifyRequest,FastifyReply} from "fastify";
import {config} from "../shared";
import {browserCookie,isOpaque,opaque,digest,operatorOrigin,NATIVE_COOKIE} from "./oauth-handoff";
import { ApiTags } from "@nestjs/swagger";
import { TikTokIntegrationService } from "./tiktok.service";

@ApiTags("integrations")
@Controller("api/v1/integrations")
export class IntegrationsController {
  constructor(private readonly tiktok: TikTokIntegrationService) {}
  @Get("tiktok")
  status() { return this.tiktok.status(); }
  @Post("tiktok/authorize")
  async authorize(@Req() request:FastifyRequest,@Res({passthrough:true}) reply:FastifyReply) {
    try {operatorOrigin(request.headers.origin,config.TIKTOK_OAUTH_OPERATOR_ORIGIN);
      if(!request.headers['content-type']?.startsWith('application/json'))throw new Error();
      const previous=browserCookie(request.headers),browser=isOpaque(previous)?previous:opaque();
      const result=await this.tiktok.initiateAuthorization(browser);
      reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('Set-Cookie',`${NATIVE_COOKIE}=${browser}; HttpOnly; SameSite=Lax; Path=/api/v1/integrations/tiktok; Max-Age=600`);
      return result;
    }catch {throw new BadRequestException('Account authorization is unavailable. Use the trusted private Outreach settings.');}
  }
  @Get("tiktok/callback")
  async callback(@Query() query:{state?:string;code?:string;error?:string},@Req() request:FastifyRequest,@Res() reply:FastifyReply) {
    let result='needs-attention';
    try {const browser=browserCookie(request.headers);
      if(!isOpaque(browser)||Object.keys(query).some(k=>!['code','state','error'].includes(k)))throw new Error();
      await this.tiktok.callback(query,{browserHash:digest(browser)});result='native-success';
    }catch{/* Never log a callback URL, code, state, provider response or exception. */}
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').code(303).header('Location',`/api/v1/integrations/tiktok/oauth-result?result=${result}`).send();
  }
  @Get('tiktok/oauth-result') result(@Query('result') value:string,@Res() reply:FastifyReply) {
    const success=value==='native-success';
    reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'; base-uri 'none'").type('text/html').send('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account connection</title></head><body><h1>'+(success?'Account connected':'Connection needs attention')+'</h1><p>Return to your private Outreach settings to review the account connection.</p></body></html>');
  }
  @Post('tiktok/private-completion')
  async complete(@Body() body:{state?:string;code?:string;operationId?:string;browserHash?:string},@Req() request:FastifyRequest,@Res() reply:FastifyReply) {
    try {const headers=new Headers();for(const k of ['x-oauth-time','x-oauth-nonce','x-oauth-signature']){const v=request.headers[k];if(typeof v==='string')headers.set(k,v);}
      await this.tiktok.privateCompletion(body,headers);reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').code(204).send();
    }catch {reply.header('Cache-Control','no-store').header('Referrer-Policy','no-referrer').code(403).send({error:'Account authorization could not be completed.'});}
  }
  @Post("tiktok/shop-selection") select(@Body() body: { externalShopId: string }) { return this.tiktok.selectShop(body.externalShopId); }
  @Post("tiktok/refresh") refresh() { return this.tiktok.refreshToken().then(() => this.tiktok.status()); }
  @Get("tiktok/creators/:creatorOpenId/performance") performance(@Param("creatorOpenId") creatorOpenId: string, @Query("validationMode") validationMode?: string) { return this.tiktok.creatorPerformance(creatorOpenId, validationMode === "true"); }
}
