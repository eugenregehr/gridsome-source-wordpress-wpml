# Gridsome Wordpress Custom Plugin with WPML support

> This is a copy of WordPress source plugin (@gridsome/source-wordpress) with wpml support

## Install
- `npm install gridsome-source-wordpress-wpml`
- `yarn add gridsome-source-wordpress-wpml`

## Usage

```js
module.exports = {
  plugins: [
    {
      use: 'gridsome-source-wordpress-wpml',
      options: {
        baseUrl: 'WEBSITE_URL', // required
        apiBase: 'wp-json',
        addLanguage: "", // use language code like "de" for single language, array for multiple ["de", "es"]
        typeName: 'WordPress',
        perPage: 100,
        concurrent: 10
      }
    }
  ],
  templates: {
    WordPressPost: '/:year/:month/:day/:slug'
  }
}
```

## GraphQL example query

```graphql
<page-query>
  query{
    allWordPressPost {
      edges {
        node {
          title
        }
      }
    }
    allWordPressPostDe {
      edges {
        node {
          title
        }
      }
    }
  }
</page-query>
```

## License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details
