import * as cdk from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elb from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';

export class WordpressStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC with Public & Private Subnets
    const vpc = new ec2.Vpc(this, 'WordpressVPC', {maxAzs: 2});

    // Security Groups
    const albSg = new ec2.SecurityGroup(this, 'ALBSecurityGroup', {vpc});
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'Allow HTTP');
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Allow HTTPS');

    const instanceSg = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {vpc});
    instanceSg.addIngressRule(albSg, ec2.Port.tcp(80), 'Allow ALB to access instances');

    const dbSg = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {vpc});
    dbSg.addIngressRule(instanceSg, ec2.Port.tcp(3306), 'Allow instances to access database');

    // SSL Certificate
    const certificate = new certificatemanager.Certificate(this, 'ALBCertificate', {
      domainName: 'yourdomain.com', // Replace with actual domain
      validation: certificatemanager.CertificateValidation.fromDns(),
    });

    // Application Load Balancer (ALB)
    const alb = new elb.ApplicationLoadBalancer(this, 'ALB', {
      vpc, internetFacing: true, securityGroup: albSg
    });

    // Redirect HTTP (80) to HTTPS (443)
    alb.addListener('HttpListener', {
      port: 80,
      defaultAction: elb.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true, // HTTP 301 Permanent Redirect
      }),
    });

    const listener = alb.addListener('HttpsListener', {
      port: 443,
      certificates: [certificate],
      defaultAction: elb.ListenerAction.fixedResponse(200, {contentType: 'text/plain', messageBody: 'OK'}),
    });

    // IAM Role for EC2 Instances
    const instanceRole = new iam.Role(this, 'WordpressInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'), iam.ManagedPolicy.fromAwsManagedPolicyName('SecretsManagerReadWrite'),]
    });

    // MySQL Credentials in Secrets Manager
    const dbSecret = new secretsmanager.Secret(this, 'WordpressDBSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({username: 'admin'}),
        generateStringKey: 'password',
        excludePunctuation: true,
      },
    });

    // Amazon RDS (MySQL)
    const db = new rds.DatabaseInstance(this, 'WordpressDB', {
      engine: rds.DatabaseInstanceEngine.mysql({version: rds.MysqlEngineVersion.VER_8_0}),
      vpc,
      securityGroups: [dbSg],
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.BURSTABLE3, ec2.InstanceSize.MICRO),
      multiAz: true,
      allocatedStorage: 20,
      credentials: rds.Credentials.fromSecret(dbSecret),
    });

    // Cloud-Init User Data for WordPress Setup
    const userData = ec2.UserData.forLinux();
    userData.addCommands('yum update -y', 'amazon-linux-extras enable nginx1', 'yum install -y nginx mariadb-server php php-mysql', 'systemctl enable nginx && systemctl start nginx', 'systemctl enable mariadb && systemctl start mariadb', 'curl -O https://wordpress.org/latest.tar.gz', 'tar -xzf latest.tar.gz -C /var/www/html', 'chown -R apache:apache /var/www/html/wordpress', 'chmod -R 755 /var/www/html/wordpress', // Fetch database credentials from Secrets Manager
        'DB_SECRET=$(aws secretsmanager get-secret-value --secret-id ' + dbSecret.secretArn + ' --query SecretString --output text)', 'DB_USER=$(echo $DB_SECRET | jq -r .username)', 'DB_PASS=$(echo $DB_SECRET | jq -r .password)', 'DB_NAME=wordpress', 'mysql -e "CREATE DATABASE $DB_NAME;" -u$DB_USER -p$DB_PASS', // Configure wp-config.php
        'cp /var/www/html/wordpress/wp-config-sample.php /var/www/html/wordpress/wp-config.php', 'sed -i "s/database_name_here/$DB_NAME/" /var/www/html/wordpress/wp-config.php', 'sed -i "s/username_here/$DB_USER/" /var/www/html/wordpress/wp-config.php', 'sed -i "s/password_here/$DB_PASS/" /var/www/html/wordpress/wp-config.php', 'systemctl restart nginx');

    // Launch Template with Cloud-Init
    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      instanceType: new ec2.InstanceType('t4g.medium'),
      machineImage: ec2.MachineImage.latestAmazonLinux2(),
      securityGroup: instanceSg,
      userData,
      role: instanceRole
    });

    // Auto Scaling Group
    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      vpc, minCapacity: 2, maxCapacity: 5, launchTemplate,
    });

    listener.addTargets('TargetGroup', {
      port: 80, targets: [asg], healthCheck: {path: '/index.php'},
    });

    // Route 53 DNS Record
    const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {domainName: 'yourdomain.com'});
    new route53.ARecord(this, 'AliasRecord', {
      zone: hostedZone, target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
    });

    // Grant EC2 access to read secrets
    dbSecret.grantRead(instanceRole);
  }
}
