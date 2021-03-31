const pMap = require("p-map");
const axios = require("axios");
const fs = require("fs");
const https = require("https");
const path = require("path");
const camelCase = require("camelcase");
const { mapKeys, isPlainObject, trimEnd, map, find } = require("lodash");

const TYPE_AUTHOR = "author";
const TYPE_ATTACHEMENT = "attachment";
const TMPDIR = ".temp/downloads";
const DOWNLOAD_DIR = "wp-images";

function mkdirSyncRecursive(absDirectory) {
    const paths = absDirectory.replace(/\/$/, "").split("/");
    paths.splice(0, 1);

    let dirPath = "/";
    paths.forEach((segment) => {
        dirPath += segment + "/";
        if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath);
    });
}

class WordPressSource {
    static defaultOptions() {
        return {
            baseUrl: "",
            apiBase: "wp-json",
            addLanguage: "",
            perPage: 100,
            concurrent: 10,
            routes: {
                post: "/:slug",
                post_tag: "/tag/:slug",
                category: "/category/:slug",
                author: "/author/:slug",
            },
            typeName: "WordPress",
            splitPostsIntoFragments: false,
            downloadRemoteImagesFromPosts: false,
            downloadRemoteFeaturedImages: false,
            downloadACFImages: false,
        };
    }

    constructor(api, options) {
        const opts = (this.options = {
            ...WordPressSource.defaultOptions,
            ...options,
        });
        this.restBases = { posts: {}, taxonomies: {} };

        if (!opts.typeName) {
            throw new Error(`Missing typeName option.`);
        }

        if (opts.perPage > 100 || opts.perPage < 1) {
            throw new Error(
                `${
                    opts.typeName
                }: perPage cannot be more than 100 or less than 1.`
            );
        }

        this.customEndpoints = this.sanitizeCustomEndpoints();
        const baseUrl = trimEnd(opts.baseUrl, "/");

        this.client = axios.create({
            baseURL: `${baseUrl}/${opts.apiBase}`,
        });

        // add languages
        this.langActive = opts.addLanguage.length > 0 ? true : false;
        this.clientLangBase = [];
        
         if(this.langActive){
          // single language 
          if(typeof opts.addLanguage == "string"){
            let createBase = axios.create({
              baseURL: `${baseUrl}/${opts.addLanguage}/${opts.apiBase}`,
            });
            this.clientLangBase.push({baseData: createBase, langCode: "_" + opts.addLanguage})
          } else {
            // multiple languages
            for(let lang of opts.addLanguage){
              let createBase = axios.create({
                baseURL: `${baseUrl}/${lang}/${opts.apiBase}`,
              });
              this.clientLangBase.push({baseData: createBase, langCode: "_" + lang})
            }
          }
        }
      

        this.routes = this.options.routes || {};

        /* Create image directories */
        mkdirSyncRecursive(path.resolve(DOWNLOAD_DIR));
        mkdirSyncRecursive(path.resolve(TMPDIR));
        this.tmpCount = 0;


        api.loadSource(async (actions) => {
            this.store = actions;

            this.slugify = (str) =>
              this.store.slugify(str).replace(/-([^-]*)$/, ".$1");

            console.log(`Loading data from ${baseUrl}`);

            await this.getOptions(actions)
            await this.getPostTypes(actions);
            await this.getUsers(actions);
            // await this.getTaxonomies(actions);
            await this.getPosts(actions);
            await this.getCustomEndpoints(actions)
        });
    }

    async getOptions(actions){
      const {defData, langData} = await this.fetch('acf/v3/options/options');

      langData.forEach(lang => {
        actions.addCollection(`AcfOptions${lang.langCode}`).addNode({
          ...lang.baseData.data
        })
      })

      actions.addCollection("AcfOptions").addNode({
        ...defData.data
      })

    }

    async getPostTypes(actions) {
        const { defData, langData } = await this.fetch("wp/v2/types", {}, {});
        const addCollection = actions.addCollection || actions.addContentType;

        for (const type in defData.data) {
            const options = defData.data[type];
            this.restBases.posts[type] = options.rest_base;
            addCollection({
                typeName: this.createTypeName(type),
                templates: this.routes[type] || `/${type}/:slug`,
            });
        }
        
      langData.forEach(lang => {
        for (const type in lang.baseData.data) {
          const typeNameLang = type + lang.langCode
          addCollection({
            typeName: this.createTypeName(typeNameLang),
            templates: this.routes[typeNameLang] || `/${typeNameLang}/:slug`,
          });
        }
      })

    }

    async getUsers(actions) {
        const { defData } = await this.fetch("wp/v2/users");
        const addCollection = actions.addCollection || actions.addContentType;

        const authors = addCollection({
            typeName: this.createTypeName(TYPE_AUTHOR),
            templates: this.routes.author,
        });

        for (const author of defData.data) {
            const fields = this.normalizeFields(author);
            const avatars = mapKeys(
                author.avatar_urls,
                (v, key) => `avatar${key}`
            );

            authors.addNode({
                ...fields,
                id: author.id,
                title: author.name,
                avatars,
            });
        }
    }

    async getTaxonomies(actions) {
        const { defData } = await this.fetch("wp/v2/taxonomies", {}, {});
        const addCollection = actions.addCollection || actions.addContentType;

        for (const type in defData.data) {
            const options = defData.data[type];
            const taxonomy = addCollection({
                typeName: this.createTypeName(type),
                templates: this.routes[type],
            });

            this.restBases.taxonomies[type] = options.rest_base;

            const terms = await this.fetchPaged(`wp/v2/${options.rest_base}`);

            for (const term of terms.defData) {
                taxonomy.addNode({
                    id: term.id,
                    title: term.name,
                    slug: term.slug,
                    content: term.description,
                    count: term.count,
                });
            }
        }
    }

    extractImagesFromPostHtml(string) {
        const regex = /<img[^>]* src=\"([^\"]*)\" alt=\"([^\"]*)\"[^>]*>/gm;

        const matches = [];
        let m;
        while ((m = regex.exec(string)) !== null) {
            // This is necessary to avoid infinite loops with zero-width matches
            if (m.index === regex.lastIndex) {
                regex.lastIndex++;
            }

            // The result can be accessed through the `m`-variable.
            m.forEach((match, groupIndex) => {
                matches.push({
                    url: match[1],
                    alt: match[2],
                });
            });
        }

        return matches;
    }

    async downloadImage(url, destPath, fileName) {
        const imagePath = path.resolve(destPath, fileName);
        const encodedURI = encodeURI(url); 

        try {
            if (fs.existsSync(imagePath)) return;
        } catch (err) {
            console.log(err);
        }

        const tmpPath = path.resolve(TMPDIR, `${++this.tmpCount}.tmp`);

        return new Promise(function(resolve, reject) {
            const file = fs.createWriteStream(tmpPath);
            https
                .get(encodedURI, (response) => {
                    response.pipe(file);
                    file.on("finish", () => {
                        file.close();
                        fs.rename(tmpPath, imagePath, resolve);
                    });
                })
                .on("error", (err) => {
                    console.error(err.message);
                    fs.unlinkSync(tmpPath); // Cleanup blank file
                    reject(err);
                });
        });
    }

    processPostFragments(post) {
        const postImages = this.extractImagesFromPostHtml(post);

        const regex = /<img[^>]* src=\"([^\"]*)\"[^>]*>/;
        const fragments = post.split(regex);

        return map(fragments, (fragment, index) => {
            const image = find(postImages, (image) => {
                return image.url === fragment;
            });
            if (image && this.options.downloadRemoteImagesFromPosts) {
                const fileName = this.slugify(fragment.split("/").pop());
                const imageData = {
                    type: "img",
                    order: index + 1,
                    fragmentData: {
                        remoteUrl: fragment,
                        fileName: fileName,
                        image: path.resolve(DOWNLOAD_DIR, fileName),
                        alt: image.alt,
                    },
                };
                this.downloadImage(fragment, DOWNLOAD_DIR, fileName);
                return imageData;
            } else {
                return {
                    type: "html",
                    order: index + 1,
                    fragmentData: {
                        html: fragment,
                    },
                };
            }
        });
    }

    async getPosts(actions) {
        const { createReference } = actions;
        const getCollection = actions.getCollection || actions.getContentType;

        const AUTHOR_TYPE_NAME = this.createTypeName(TYPE_AUTHOR);
        const ATTACHEMENT_TYPE_NAME = this.createTypeName(TYPE_ATTACHEMENT);

        for (const type in this.restBases.posts) {
            const restBase = this.restBases.posts[type];
            const typeName = this.createTypeName(type);
            
            const posts = getCollection(typeName);
           
            console.log(`Loading data for ${restBase}`);
            
            const res = await this.fetchPaged(`wp/v2/${restBase}?_embed`);

            
            for (const post of res.defData.data) {
                const fields = this.normalizeFields(post);

                fields.author = createReference(
                    AUTHOR_TYPE_NAME,
                    post.author || "0"
                );

                if (post.type !== TYPE_ATTACHEMENT) {
                    fields.featuredMedia = createReference(
                        ATTACHEMENT_TYPE_NAME,
                        post.featured_media
                    );
                }

                // add references if post has any taxonomy rest bases as properties
                for (const type in this.restBases.taxonomies) {
                    const propName = this.restBases.taxonomies[type];

                    if (post.hasOwnProperty(propName)) {
                        const typeName = this.createTypeName(type);
                        const ref = createReference(typeName, post[propName]);
                        const key = camelCase(propName);

                        fields[key] = ref;
                    }
                }

                if (this.options.splitPostsIntoFragments && fields["content"]) {
                    fields.postFragments = this.processPostFragments(
                        fields["content"]
                    );
                }

                // download the featured image
                if (
                    this.options.downloadRemoteFeaturedImages &&
                    post._embedded &&
                    post._embedded["wp:featuredmedia"]
                ) {
                    try {
                        const featuredImageFileName = this.slugify(
                            post._embedded["wp:featuredmedia"]["0"].source_url
                                .split("/")
                                .pop()
                        );
                        await this.downloadImage(
                            post._embedded["wp:featuredmedia"]["0"].source_url,
                            DOWNLOAD_DIR,
                            featuredImageFileName
                        );
                        fields.featuredMediaImage = path.resolve(
                            DOWNLOAD_DIR,
                            featuredImageFileName
                        );
                    } catch (err) {
                        console.log(err);
                        console.log(
                            "WARNING - No featured image for post " + post.slug
                        );
                    }
                }

                posts.addNode({
                    ...fields,
                    id: post.id,
                });
            }
            
            // load language data 
            res.langData.forEach(lang => {

              const typeNameLang = this.createTypeName(type + lang.langCode);
              const postsLang = getCollection(typeNameLang)

              for( const postLang of lang.baseData.data){
                const fieldsLang = this.normalizeFields(postLang);
                postsLang.addNode({
                  ...fieldsLang,
                  id: postLang.id
                })
              }    
            })
        }
       
    }

    async getCustomEndpoints (actions) {
      for (const endpoint of this.customEndpoints) {
        const makeCollection = actions.addCollection || actions.addContentType
        const cepCollection = makeCollection({
          typeName: endpoint.typeName
        })
        const { defData } = await this.fetch(endpoint.route, {}, {})
        for (let item of defData.data) { 
          if (endpoint.normalize) {
            item = this.normalizeFields(item)
          }

          cepCollection.addNode({
            ...item,
            id: item.id || item.slug
          })
        }
      }
    }

    async fetch(url, params = {}, fallbackData = []) {
      let res;
      let resLang = [];

      try {
          res = await this.client.request({ url, params });
          // console.log(res.data);
          if(this.langActive){
            for(let lang of this.clientLangBase){                
                const langData = await lang.baseData.request({ url, params });
                resLang.push({baseData: langData, langCode: lang.langCode})
            }
          }
      } catch ({ response, code, config }) {
          if (!response && code) {
              throw new Error(`${code} - ${config.url}`);
          }

          const { url } = response.config;
          const { status } = response.data.data;

          if ([401, 403].includes(status)) {
              console.warn(`Error: Status ${status} - ${url}`);
              return { ...response, data: fallbackData };
          } else {
              throw new Error(`${status} - ${url}`);
          }
      }
      return {defData: res, langData: resLang};
    }

    async fetchPaged(path) {
        const { perPage, concurrent } = this.options;

        return new Promise(async (resolve, reject) => {
            let res;

            try {
                res = await this.fetch(path, { per_page: perPage });
            } catch (err) {
                return reject(err);
            }

            resolve(res);
        });
    }

    sanitizeCustomEndpoints () {
      if (!this.options.customEndpoints) return []
      if (!Array.isArray(this.options.customEndpoints)) throw Error('customEndpoints must be an array')
      this.options.customEndpoints.forEach(endpoint => {
        if (!endpoint.typeName) {
          throw Error('Please provide a typeName option for all customEndpoints\n')
        }
        if (!endpoint.route) {
          throw Error(`No route option in endpoint: ${endpoint.typeName}\n Ex: 'apiName/versionNumber/endpointObject'`)
        }
      })
      return this.options.customEndpoints ? this.options.customEndpoints : []
    }

    normalizeFields(fields, isACF) {
        const res = {};

        for (const key in fields) {
            if (key.startsWith("_")) continue; // skip links and embeds etc
            res[camelCase(key)] = this.normalizeFieldValue(
                fields[key],
                isACF || key === "acf"
            );
        }

        return res;
    }

    normalizeFieldValue(value, isACF) {
        if (value === null) return null;
        if (value === undefined) return null;
        

        if (Array.isArray(value)) {
            return value.map((v) => this.normalizeFieldValue(v, isACF));
        }

        if (isPlainObject(value)) {
            if (
                value.type === "image" &&
                value.filename &&
                value.url &&
                isACF &&
                this.options.downloadACFImages
            ) {
                const filename = this.slugify(value.filename);
                this.downloadImage(value.url, DOWNLOAD_DIR, filename);
                return {
                    src: path.resolve(DOWNLOAD_DIR, filename),
                    title: value.title,
                    alt: value.description,
                };
            } else if (value.post_type && (value.ID || value.id)) {
                const typeName = this.createTypeName(value.post_type);
                const id = value.ID || value.id;

                return this.store.createReference(typeName, id);
            } else if (value.filename && (value.ID || value.id)) {
                const typeName = this.createTypeName(TYPE_ATTACHEMENT);
                const id = value.ID || value.id;

                return this.store.createReference(typeName, id);
            } else if (value.hasOwnProperty("rendered")) {
                return value.rendered;
            }

            return this.normalizeFields(value, isACF);
        }

        if (
            isACF &&
            this.options.downloadACFImages &&
            String(value).match(/^http:\/\/.*\/.*\.(jpg|png|svg|jpeg)($|\?)/i)
        ) {
            const filename = this.slugify(value.split("/").pop());
            console.log(`Downloading ${filename}`);
            this.downloadImage(value, DOWNLOAD_DIR, filename);
            return path.resolve(DOWNLOAD_DIR, filename);
        }
  

        return value;
    }

    createTypeName(name = "") {
        return camelCase(`${this.options.typeName} ${name}`, {
            pascalCase: true,
        });
    }
}

function ensureArrayData(url, data) {
    if (!Array.isArray(data)) {
        try {
            data = JSON.parse(data);
        } catch (err) {
            throw new Error(
                `Failed to fetch ${url}\n` +
                    `Expected JSON response but received:\n` +
                    `${data.trim().substring(0, 150)}...\n`
            );
        }
    }
    return data;
}

module.exports = WordPressSource;
