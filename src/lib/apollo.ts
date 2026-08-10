import { ApolloClient, InMemoryCache, HttpLink } from '@apollo/client'

// Keep Hasura credentials server-side. The browser talks to the same-origin
// proxy, which forwards GraphQL requests to Nhost with the admin secret.
const httpLink = new HttpLink({ uri: '/api/graphql' })

export const apolloClient = new ApolloClient({
  link: httpLink,
  cache: new InMemoryCache(),
})
