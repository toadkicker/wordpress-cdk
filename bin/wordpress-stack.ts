#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import 'dotenv/config';
import { WordpressStack } from '../lib/wordpress-stack';

const app = new cdk.App();

new WordpressStack(app, 'WordpressStack', {
  env: {
    account: process.env.AWS_ACCOUNT,
    region: process.env.AWS_REGION
  }
});

app.synth();
