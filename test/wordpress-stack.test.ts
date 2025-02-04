import * as cdk from 'aws-cdk-lib';
import {Match, Template} from 'aws-cdk-lib/assertions';
import {WordpressStack} from '../lib/wordpress-stack';

describe('WordpressStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new WordpressStack(app, 'TestWordpressStack', {
      env: {
        account: process.env.AWS_ACCOUNT || '123456789012', region: process.env.AWS_REGION || 'us-west-2'
      }
    });
    template = Template.fromStack(stack);
  });

  test('VPC is created with multiple subnets', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {});

    template.resourceCountIs('AWS::EC2::Subnet', 4); // Ensures subnets exist
  });

  test('ALB is internet-facing and has an HTTPS listener', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
    });

    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443, Protocol: 'HTTPS',
    });
  });

  test('Auto Scaling Group exists with t4g.medium instances', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: {
        InstanceType: 't4g.medium',
      }
    });
  });

  test('MySQL RDS database is created with Secrets Manager credentials', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'mysql', MasterUserPassword: {
        'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('{{resolve:secretsmanager:'), {Ref: Match.stringLikeRegexp('WordpressDBSecret')}, Match.stringLikeRegexp(':SecretString:password(:?::}})?') // Allows optional "::}}"
        ])]
      }
    });

    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      GenerateSecretString: {
        SecretStringTemplate: '{"username":"admin"}', GenerateStringKey: 'password', ExcludePunctuation: true,
      },
    });
  });

  test('IAM Role for EC2 instances includes Secrets Manager Read access', () => {
    // Check IAM Role creation
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([{
          Effect: 'Allow', Principal: {Service: 'ec2.amazonaws.com'}, Action: 'sts:AssumeRole',
        },]),
      },
    });

    // Check that the Managed Policy is attached to the EC2 Role
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([Match.stringLikeRegexp('arn:aws:iam::aws:policy/SecretsManagerReadWrite')]),
    });
  });

  test('Route 53 Alias Record is created for the ALB', () => {
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Type: 'A', AliasTarget: Match.objectLike({
        DNSName: Match.anyValue(),
      }),
    });
  });
});
