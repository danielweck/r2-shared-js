// ==LICENSE-BEGIN==
// Copyright 2017 European Digital Reading Lab. All rights reserved.
// Licensed to the Readium Foundation under one or more contributor license agreements.
// Use of this source code is governed by a BSD-style license
// that can be found in the LICENSE file exposed on Github (readium) in the project repository.
// ==LICENSE-END==

import * as debug_ from "debug";
import * as moment from "moment";
import * as path from "path";
import * as xmldom from "xmldom";

import { MediaOverlayNode, timeStrToSeconds } from "@models/media-overlay";
import { DirectionEnum } from "@models/metadata";
import { Contributor } from "@models/metadata-contributor";
import { MediaOverlay } from "@models/metadata-media-overlay";
import { IStringMap } from "@models/metadata-multilang";
import { Properties } from "@models/metadata-properties";
import { Subject } from "@models/metadata-subject";
import { Publication } from "@models/publication";
import { Link } from "@models/publication-link";
import { DelinearizeAccessModeSufficient } from "@models/ta-json-string-tokens-converter";
import { encodeURIComponent_RFC3986 } from "@r2-utils-js/_utils/http/UrlUtils";
import { streamToBufferPromise } from "@r2-utils-js/_utils/stream/BufferUtils";
import { XML } from "@r2-utils-js/_utils/xml-js-mapper";
import { IStreamAndLength, IZip } from "@r2-utils-js/_utils/zip/zip";

import { zipHasEntry } from "../_utils/zipHasEntry";
import { Rootfile } from "./epub/container-rootfile";
import { NCX } from "./epub/ncx";
import { NavPoint } from "./epub/ncx-navpoint";
import { OPF } from "./epub/opf";
import { Author } from "./epub/opf-author";
import { Manifest } from "./epub/opf-manifest";
import { Metafield } from "./epub/opf-metafield";
import { Title } from "./epub/opf-title";

const debug = debug_("r2:shared#parser/epub-daisy-common");

const epub3 = "3.0";
const epub301 = "3.0.1";
const epub31 = "3.1";
// const epub2 = "2.0";
// const epub201 = "2.0.1";

export const mediaOverlayURLPath = "media-overlay.json";
export const mediaOverlayURLParam = "resource";

// https://github.com/readium/webpub-manifest/issues/52#issuecomment-601686135
export const BCP47_UNKNOWN_LANG = "und";

export const parseSpaceSeparatedString = (str: string | undefined | null): string[] => {
    return str ? str.trim().split(" ").map((role) => {
        return role.trim();
    }).filter((role) => {
        return role.length > 0;
    }) : [];
};

const getEpubVersion = (rootfile: Rootfile, opf: OPF): string | undefined => {

    if (rootfile.Version) {
        return rootfile.Version;
    } else if (opf.Version) {
        return opf.Version;
    }

    return undefined;
};

export const isEpub3OrMore = (rootfile: Rootfile, opf: OPF): boolean => {

    const version = getEpubVersion(rootfile, opf);
    return (version === epub3 || version === epub301 || version === epub31);
};

export const fillPublicationDate = (publication: Publication, rootfile: Rootfile | undefined, opf: OPF) => {

    const opfMetadataDate =
        opf.Metadata?.DCMetadata?.Date?.length ?
            opf.Metadata.DCMetadata.Date :
            (opf.Metadata?.Date?.length ?
                opf.Metadata.Date :
                undefined);

    if (opfMetadataDate) {

        if ((!rootfile || isEpub3OrMore(rootfile, opf)) &&
            opfMetadataDate[0] && opfMetadataDate[0].Data) {

            const token = opfMetadataDate[0].Data;
            try {
                const mom = moment(token);
                if (mom.isValid()) {
                    publication.Metadata.PublicationDate = mom.toDate();
                }
            } catch (err) {
                debug("INVALID DATE/TIME? " + token);
            }
            return;
        }

        opfMetadataDate.forEach((date) => {
            if (date.Data && date.Event && date.Event.indexOf("publication") >= 0) {
                const token = date.Data;
                try {
                    const mom = moment(token);
                    if (mom.isValid()) {
                        publication.Metadata.PublicationDate = mom.toDate();
                    }
                } catch (err) {
                    debug("INVALID DATE/TIME? " + token);
                }
            }
        });
    }
};

export const fillSubject = (publication: Publication, opf: OPF) => {

    const opfMetadataSubject =
        opf.Metadata?.DCMetadata?.Subject?.length ?
            opf.Metadata.DCMetadata.Subject :
            (opf.Metadata?.Subject?.length ?
                opf.Metadata.Subject :
                undefined);

    if (opfMetadataSubject) {
        opfMetadataSubject.forEach((s) => {
            const sub = new Subject();
            if (s.Lang) {
                sub.Name = {} as IStringMap;
                sub.Name[s.Lang] = s.Data;
            } else {
                sub.Name = s.Data;
            }
            sub.Code = s.Term;
            sub.Scheme = s.Authority;
            if (!publication.Metadata.Subject) {
                publication.Metadata.Subject = [];
            }
            publication.Metadata.Subject.push(sub);
        });
    }
};

export const findContributorInMeta = (publication: Publication, rootfile: Rootfile | undefined, opf: OPF) => {
    if (!rootfile || isEpub3OrMore(rootfile, opf)) {
        const func = (meta: Metafield) => {
            if (meta.Property === "dcterms:creator" || meta.Property === "dcterms:contributor") {
                const cont = new Author();
                cont.Data = meta.Data;
                cont.ID = meta.ID;
                addContributor(publication, rootfile, opf, cont, undefined);
            }
        };
        if (opf.Metadata?.XMetadata?.Meta?.length) {
            opf.Metadata.XMetadata.Meta.forEach(func);
        }
        if (opf.Metadata?.Meta?.length) {
            opf.Metadata.Meta.forEach(func);
        }
    }
};

export const addContributor = (
    publication: Publication, rootfile: Rootfile | undefined,
    opf: OPF, cont: Author, forcedRole: string | undefined) => {

    const contributor = new Contributor();
    let role: string | undefined;

    // const epubVersion = getEpubVersion(rootfile, opf);

    if (rootfile && isEpub3OrMore(rootfile, opf)) {

        if (cont.FileAs) {
            contributor.SortAs = cont.FileAs;
        } else {
            const metaFileAs = findMetaByRefineAndProperty(opf, cont.ID, "file-as");
            if (metaFileAs && metaFileAs.Property === "file-as") {
                contributor.SortAs = metaFileAs.Data;
            }
        }

        const metaRole = findMetaByRefineAndProperty(opf, cont.ID, "role");
        if (metaRole && metaRole.Property === "role") {
            role = metaRole.Data;
        }
        if (!role && forcedRole) {
            role = forcedRole;
        }

        const metaAlt = findAllMetaByRefineAndProperty(opf, cont.ID, "alternate-script");
        if (metaAlt && metaAlt.length) {
            contributor.Name = {} as IStringMap;

            metaAlt.forEach((m) => {
                if (m.Lang) {
                    (contributor.Name as IStringMap)[m.Lang] = m.Data;
                }
            });

            // https://github.com/readium/architecture/blob/master/streamer/parser/metadata.md#title
            const xmlLang: string = cont.Lang || opf.Lang;
            if (xmlLang) {
                contributor.Name[xmlLang.toLowerCase()] = cont.Data;
            } else if (publication.Metadata &&
                publication.Metadata.Language &&
                publication.Metadata.Language.length &&
                !contributor.Name[publication.Metadata.Language[0].toLowerCase()]) {
                contributor.Name[publication.Metadata.Language[0].toLowerCase()] = cont.Data;
            } else {
                // tslint:disable-next-line: no-string-literal
                contributor.Name[BCP47_UNKNOWN_LANG] = cont.Data;
            }
        } else {
            contributor.Name = cont.Data;
        }
    } else {
        contributor.Name = cont.Data;
        role = cont.Role;
        if (!role && forcedRole) {
            role = forcedRole;
        }
    }

    if (role) {
        switch (role) {
            case "aut": {
                if (!publication.Metadata.Author) {
                    publication.Metadata.Author = [];
                }
                publication.Metadata.Author.push(contributor);
                break;
            }
            case "trl": {
                if (!publication.Metadata.Translator) {
                    publication.Metadata.Translator = [];
                }
                publication.Metadata.Translator.push(contributor);
                break;
            }
            case "art": {
                if (!publication.Metadata.Artist) {
                    publication.Metadata.Artist = [];
                }
                publication.Metadata.Artist.push(contributor);
                break;
            }
            case "edt": {
                if (!publication.Metadata.Editor) {
                    publication.Metadata.Editor = [];
                }
                publication.Metadata.Editor.push(contributor);
                break;
            }
            case "ill": {
                if (!publication.Metadata.Illustrator) {
                    publication.Metadata.Illustrator = [];
                }
                publication.Metadata.Illustrator.push(contributor);
                break;
            }
            case "ltr": {
                if (!publication.Metadata.Letterer) {
                    publication.Metadata.Letterer = [];
                }
                publication.Metadata.Letterer.push(contributor);
                break;
            }
            case "pen": {
                if (!publication.Metadata.Penciler) {
                    publication.Metadata.Penciler = [];
                }
                publication.Metadata.Penciler.push(contributor);
                break;
            }
            case "clr": {
                if (!publication.Metadata.Colorist) {
                    publication.Metadata.Colorist = [];
                }
                publication.Metadata.Colorist.push(contributor);
                break;
            }
            case "ink": {
                if (!publication.Metadata.Inker) {
                    publication.Metadata.Inker = [];
                }
                publication.Metadata.Inker.push(contributor);
                break;
            }
            case "nrt": {
                if (!publication.Metadata.Narrator) {
                    publication.Metadata.Narrator = [];
                }
                publication.Metadata.Narrator.push(contributor);
                break;
            }
            case "pbl": {
                if (!publication.Metadata.Publisher) {
                    publication.Metadata.Publisher = [];
                }
                publication.Metadata.Publisher.push(contributor);
                break;
            }
            default: {
                contributor.Role = [role];

                if (!publication.Metadata.Contributor) {
                    publication.Metadata.Contributor = [];
                }
                publication.Metadata.Contributor.push(contributor);
            }
        }
    }
};

export const findMetaByRefineAndProperty = (opf: OPF, ID: string, property: string): Metafield | undefined => {

    const ret = findAllMetaByRefineAndProperty(opf, ID, property);
    if (ret.length) {
        return ret[0];
    }
    return undefined;
};

export const findAllMetaByRefineAndProperty = (opf: OPF, ID: string, property: string): Metafield[] => {

    const metas: Metafield[] = [];

    const refineID = "#" + ID;

    const func = (metaTag: Metafield) => {
        if (metaTag.Refine === refineID && metaTag.Property === property) {
            metas.push(metaTag);
        }
    };
    if (opf.Metadata?.XMetadata?.Meta?.length) {
        opf.Metadata.XMetadata.Meta.forEach(func);
    }
    if (opf.Metadata?.Meta?.length) {
        opf.Metadata.Meta.forEach(func);
    }

    return metas;
};

export const findInSpineByHref = (publication: Publication, href: string): Link | undefined => {

    if (publication.Spine && publication.Spine.length) {
        const ll = publication.Spine.find((l) => {
            if (l.HrefDecoded === href) {
                return true;
            }
            return false;
        });
        if (ll) {
            return ll;
        }
    }

    return undefined;
};

type FuncType = (
    publication: Publication, rootfile: Rootfile | undefined,
    opf: OPF, zip: IZip, linkItem: Link, item: Manifest) => Promise<void>;

export const findInManifestByID = async (
    publication: Publication, rootfile: Rootfile | undefined, opf: OPF, ID: string, zip: IZip,
    addLinkData: FuncType): Promise<Link> => {

    if (opf.Manifest && opf.Manifest.length) {
        const item = opf.Manifest.find((manItem) => {
            if (manItem.ID === ID) {
                return true;
            }
            return false;
        });
        if (item && opf.ZipPath) {
            const linkItem = new Link();
            linkItem.TypeLink = item.MediaType;

            const itemHrefDecoded = item.HrefDecoded;
            if (!itemHrefDecoded) {
                return Promise.reject("item.Href?!");
            }
            linkItem.setHrefDecoded(path.join(path.dirname(opf.ZipPath), itemHrefDecoded)
                .replace(/\\/g, "/"));

            await addLinkData(publication, rootfile, opf, zip, linkItem, item);

            return linkItem;
        }
    }
    return Promise.reject(`ID ${ID} not found`);
};

export const fillSpineAndResource = async (
    publication: Publication, rootfile: Rootfile | undefined, opf: OPF, zip: IZip,
    addLinkData: FuncType) => {

    if (!opf.ZipPath) {
        return;
    }

    if (opf.Spine && opf.Spine.Items && opf.Spine.Items.length) {
        for (const item of opf.Spine.Items) {

            if (!item.Linear || item.Linear === "yes") {

                let linkItem: Link;
                try {
                    linkItem = await findInManifestByID(publication, rootfile, opf, item.IDref, zip, addLinkData);
                } catch (err) {
                    debug(err);
                    continue;
                }

                if (linkItem && linkItem.Href) {
                    if (!publication.Spine) {
                        publication.Spine = [];
                    }
                    publication.Spine.push(linkItem);
                }
            }
        }
    }

    if (opf.Manifest && opf.Manifest.length) {

        for (const item of opf.Manifest) {

            const itemHrefDecoded = item.HrefDecoded;
            if (!itemHrefDecoded) {
                debug("!? item.Href");
                continue;
            }
            const zipPath = path.join(path.dirname(opf.ZipPath), itemHrefDecoded)
                .replace(/\\/g, "/");
            const linkSpine = findInSpineByHref(publication, zipPath);
            if (!linkSpine || !linkSpine.Href) {

                const linkItem = new Link();
                linkItem.TypeLink = item.MediaType;

                linkItem.setHrefDecoded(zipPath);

                await addLinkData(publication, rootfile, opf, zip, linkItem, item);

                if (!publication.Resources) {
                    publication.Resources = [];
                }
                publication.Resources.push(linkItem);
            }
        }
    }
};

export const addLanguage = (publication: Publication, opf: OPF) => {

    const opfMetadataLanguage =
        opf.Metadata?.DCMetadata?.Language?.length ?
            opf.Metadata.DCMetadata.Language :
            (opf.Metadata?.Language?.length ?
                opf.Metadata.Language :
                undefined);

    if (opfMetadataLanguage) {
        publication.Metadata.Language = opfMetadataLanguage;
    }
};

export const addIdentifier = (publication: Publication, opf: OPF) => {

    const opfMetadataIdentifier =
        opf.Metadata?.DCMetadata?.Identifier?.length ?
            opf.Metadata.DCMetadata.Identifier :
            (opf.Metadata?.Identifier?.length ?
                opf.Metadata.Identifier :
                undefined);

    if (opfMetadataIdentifier) {
        if (opf.UniqueIdentifier && opfMetadataIdentifier.length > 1) {
            opfMetadataIdentifier.forEach((iden) => {
                if (iden.ID === opf.UniqueIdentifier) {
                    publication.Metadata.Identifier = iden.Data;
                }
            });
        } else if (opfMetadataIdentifier.length > 0) {
            publication.Metadata.Identifier = opfMetadataIdentifier[0].Data;
        }
    }
};

export const addTitle = (publication: Publication, rootfile: Rootfile | undefined, opf: OPF) => {

    const opfMetadataTitle =
        opf.Metadata?.DCMetadata?.Title?.length ?
            opf.Metadata.DCMetadata.Title :
            (opf.Metadata?.Title?.length ?
                opf.Metadata.Title :
                undefined);

    if (rootfile && isEpub3OrMore(rootfile, opf)) {
        let mainTitle: Title | undefined;
        let subTitle: Title | undefined;
        let subTitleDisplaySeq = 0;

        if (opfMetadataTitle) {

            if (opf.Metadata?.Meta || opf.Metadata?.XMetadata?.Meta) {
                const tt = opfMetadataTitle.find((title) => {
                    const refineID = "#" + title.ID;

                    const func0 = (meta: Metafield) => {
                        // meta.Property === "title-type"
                        if (meta.Data === "main" && meta.Refine === refineID) {
                            return true;
                        }
                        return false;
                    };
                    let m = opf.Metadata?.Meta ? opf.Metadata.Meta.find(func0) : undefined;
                    if (!m && opf.Metadata?.XMetadata?.Meta) {
                        m = opf.Metadata.XMetadata.Meta.find(func0);
                    }
                    if (m) {
                        return true;
                    }
                    return false;
                });
                if (tt) {
                    mainTitle = tt;
                }

                opfMetadataTitle.forEach((title) => {
                    const refineID = "#" + title.ID;

                    const func1 = (meta: Metafield) => {
                        // meta.Property === "title-type"
                        if (meta.Data === "subtitle" && meta.Refine === refineID) {
                            return true;
                        }
                        return false;
                    };
                    let m = opf.Metadata?.Meta ? opf.Metadata.Meta.find(func1) : undefined;
                    if (!m && opf.Metadata?.XMetadata?.Meta) {
                        m = opf.Metadata.XMetadata.Meta.find(func1);
                    }
                    if (m) {
                        let titleDisplaySeq = 0;
                        const func2 = (meta: Metafield) => {
                            if (meta.Property === "display-seq" && meta.Refine === refineID) {
                                return true;
                            }
                            return false;
                        };
                        let mds = opf.Metadata?.Meta ? opf.Metadata.Meta.find(func2) : undefined;
                        if (!mds && opf.Metadata?.XMetadata?.Meta) {
                            mds = opf.Metadata.XMetadata.Meta.find(func2);
                        }
                        if (mds) {
                            try {
                                titleDisplaySeq = parseInt(mds.Data, 10);
                            } catch (err) {
                                debug(err);
                                debug(mds.Data);
                                titleDisplaySeq = 0;
                            }
                            if (isNaN(titleDisplaySeq)) {
                                debug("NaN");
                                debug(mds.Data);
                                titleDisplaySeq = 0;
                            }
                        } else {
                            titleDisplaySeq = 0;
                        }
                        if (!subTitle || titleDisplaySeq < subTitleDisplaySeq) {
                            subTitle = title;
                            subTitleDisplaySeq = titleDisplaySeq;
                        }
                    }
                });
            }

            if (!mainTitle) {
                mainTitle = opfMetadataTitle[0];
            }
        }

        if (mainTitle) {
            const metaAlt = findAllMetaByRefineAndProperty(opf, mainTitle.ID, "alternate-script");
            if (metaAlt && metaAlt.length) {
                publication.Metadata.Title = {} as IStringMap;

                metaAlt.forEach((m) => {
                    if (m.Lang) {
                        (publication.Metadata.Title as IStringMap)[m.Lang.toLowerCase()] = m.Data;
                    }
                });

                // https://github.com/readium/architecture/blob/master/streamer/parser/metadata.md#title
                const xmlLang: string = mainTitle.Lang || opf.Lang;
                if (xmlLang) {
                    publication.Metadata.Title[xmlLang.toLowerCase()] = mainTitle.Data;
                } else if (publication.Metadata.Language &&
                    publication.Metadata.Language.length &&
                    !publication.Metadata.Title[publication.Metadata.Language[0].toLowerCase()]) {
                    publication.Metadata.Title[publication.Metadata.Language[0].toLowerCase()] = mainTitle.Data;
                } else {
                    // tslint:disable-next-line: no-string-literal
                    publication.Metadata.Title[BCP47_UNKNOWN_LANG] = mainTitle.Data;
                }

            } else {
                publication.Metadata.Title = mainTitle.Data;
            }
        }

        if (subTitle) {
            const metaAlt = findAllMetaByRefineAndProperty(opf, subTitle.ID, "alternate-script");
            if (metaAlt && metaAlt.length) {
                publication.Metadata.SubTitle = {} as IStringMap;

                metaAlt.forEach((m) => {
                    if (m.Lang) {
                        (publication.Metadata.SubTitle as IStringMap)[m.Lang.toLowerCase()] = m.Data;
                    }
                });

                // https://github.com/readium/architecture/blob/master/streamer/parser/metadata.md#title
                const xmlLang: string = subTitle.Lang || opf.Lang;
                if (xmlLang) {
                    publication.Metadata.SubTitle[xmlLang.toLowerCase()] = subTitle.Data;
                } else if (publication.Metadata.Language &&
                    publication.Metadata.Language.length &&
                    !publication.Metadata.SubTitle[publication.Metadata.Language[0].toLowerCase()]) {
                    publication.Metadata.SubTitle[publication.Metadata.Language[0].toLowerCase()] = subTitle.Data;
                } else {
                    // tslint:disable-next-line: no-string-literal
                    publication.Metadata.SubTitle[BCP47_UNKNOWN_LANG] = subTitle.Data;
                }

            } else {
                publication.Metadata.SubTitle = subTitle.Data;
            }
        }

    } else {
        if (opfMetadataTitle) {
            publication.Metadata.Title = opfMetadataTitle[0].Data;
        }
    }
};

export const setPublicationDirection = (publication: Publication, opf: OPF) => {

    if (opf.Spine && opf.Spine.PageProgression) {
        switch (opf.Spine.PageProgression) {
            case "auto": {
                publication.Metadata.Direction = DirectionEnum.Auto;
                break;
            }
            case "ltr": {
                publication.Metadata.Direction = DirectionEnum.LTR;
                break;
            }
            case "rtl": {
                publication.Metadata.Direction = DirectionEnum.RTL;
                break;
            }
        }
    }

    if (publication.Metadata.Language && publication.Metadata.Language.length &&
        (!publication.Metadata.Direction || publication.Metadata.Direction === DirectionEnum.Auto)) {

        const lang = publication.Metadata.Language[0].toLowerCase();
        if ((lang === "ar" || lang.startsWith("ar-") ||
            lang === "he" || lang.startsWith("he-") ||
            lang === "fa" || lang.startsWith("fa-")) ||
            lang === "zh-Hant" ||
            lang === "zh-TW") {

            publication.Metadata.Direction = DirectionEnum.RTL;
        }
    }
};

export const getNcx = async (ncxManItem: Manifest, opf: OPF, zip: IZip): Promise<NCX> => {

    if (!opf.ZipPath) {
        return Promise.reject("?!!opf.ZipPath");
    }

    const dname = path.dirname(opf.ZipPath);
    const ncxManItemHrefDecoded = ncxManItem.HrefDecoded;
    if (!ncxManItemHrefDecoded) {
        return Promise.reject("?!ncxManItem.Href");
    }
    const ncxFilePath = path.join(dname, ncxManItemHrefDecoded).replace(/\\/g, "/");

    const has = await zipHasEntry(zip, ncxFilePath, undefined);
    if (!has) {
        const err = `NOT IN ZIP (NCX): ${ncxManItem.Href} --- ${ncxFilePath}`;
        debug(err);
        const zipEntries = await zip.getEntries();
        for (const zipEntry of zipEntries) {
            debug(zipEntry);
        }
        return Promise.reject(err);
    }

    let ncxZipStream_: IStreamAndLength;
    try {
        ncxZipStream_ = await zip.entryStreamPromise(ncxFilePath);
    } catch (err) {
        debug(err);
        return Promise.reject(err);
    }
    const ncxZipStream = ncxZipStream_.stream;

    let ncxZipData: Buffer;
    try {
        ncxZipData = await streamToBufferPromise(ncxZipStream);
    } catch (err) {
        debug(err);
        return Promise.reject(err);
    }

    const ncxStr = ncxZipData.toString("utf8");
    const ncxDoc = new xmldom.DOMParser().parseFromString(ncxStr);
    const ncx = XML.deserialize<NCX>(ncxDoc, NCX);
    ncx.ZipPath = ncxFilePath;

    // breakLength: 100  maxArrayLength: undefined
    // debug(util.inspect(ncx,
    //     { showHidden: false, depth: 1000, colors: true, customInspect: true }));

    return ncx;
};

export const getOpf = async (zip: IZip, rootfilePathDecoded: string, rootfilePath: string): Promise<OPF> => {

    // let timeBegin = process.hrtime();
    const has = await zipHasEntry(zip, rootfilePathDecoded, rootfilePath);
    if (!has) {
        const err = `NOT IN ZIP (container OPF rootfile): ${rootfilePath} --- ${rootfilePathDecoded}`;
        debug(err);
        const zipEntries = await zip.getEntries();
        for (const zipEntry of zipEntries) {
            debug(zipEntry);
        }
        return Promise.reject(err);
    }

    let opfZipStream_: IStreamAndLength;
    try {
        opfZipStream_ = await zip.entryStreamPromise(rootfilePathDecoded);
    } catch (err) {
        debug(err);
        return Promise.reject(err);
    }
    const opfZipStream = opfZipStream_.stream;

    // const timeElapsed1 = process.hrtime(timeBegin);
    // debug(`1) ${timeElapsed1[0]} seconds + ${timeElapsed1[1]} nanoseconds`);
    // timeBegin = process.hrtime();

    let opfZipData: Buffer;
    try {
        opfZipData = await streamToBufferPromise(opfZipStream);
    } catch (err) {
        debug(err);
        return Promise.reject(err);
    }

    // debug(`${opfZipData.length} bytes`);

    // const timeElapsed2 = process.hrtime(timeBegin);
    // debug(`2) ${timeElapsed2[0]} seconds + ${timeElapsed2[1]} nanoseconds`);
    // timeBegin = process.hrtime();

    const opfStr = opfZipData.toString("utf8");

    // const timeElapsed3 = process.hrtime(timeBegin);
    // debug(`3) ${timeElapsed3[0]} seconds + ${timeElapsed3[1]} nanoseconds`);
    // timeBegin = process.hrtime();

    // TODO: this takes some time with large OPF XML data
    // (typically: many manifest items),
    // but it remains acceptable.
    // e.g. BasicTechnicalMathWithCalculus.epub with 2.5MB OPF!
    const opfDoc = new xmldom.DOMParser().parseFromString(opfStr);

    // const timeElapsed4 = process.hrtime(timeBegin);
    // debug(`4) ${timeElapsed4[0]} seconds + ${timeElapsed4[1]} nanoseconds`);
    // const timeBegin = process.hrtime();

    // tslint:disable-next-line:no-string-literal
    // process.env["OPF_PARSE"] = "true";
    // TODO: this takes a MASSIVE amount of time with large OPF XML data
    // (typically: many manifest items)
    // e.g. BasicTechnicalMathWithCalculus.epub with 2.5MB OPF!
    // culprit: XPath lib ... so we use our own mini XPath parser/matcher
    // (=> performance gain in orders of magnitude!)
    const opf = XML.deserialize<OPF>(opfDoc, OPF);
    // tslint:disable-next-line:no-string-literal
    // process.env["OPF_PARSE"] = "false";

    // const timeElapsed5 = process.hrtime(timeBegin);
    // debug(`5) ${timeElapsed5[0]} seconds + ${timeElapsed5[1]} nanoseconds`);

    opf.ZipPath = rootfilePathDecoded;

    // breakLength: 100  maxArrayLength: undefined
    // debug(util.inspect(opf,
    //     { showHidden: false, depth: 1000, colors: true, customInspect: true }));

    return opf;
};

export const addOtherMetadata = (publication: Publication, rootfile: Rootfile | undefined, opf: OPF) => {

    if (!opf.Metadata?.DCMetadata) {
        return;
    }

    const opfMetadataRights =
        opf.Metadata?.DCMetadata?.Rights?.length ?
            opf.Metadata.DCMetadata.Rights :
            (opf.Metadata?.Rights?.length ?
                opf.Metadata.Rights :
                undefined);
    if (opfMetadataRights) {
        publication.Metadata.Rights = opfMetadataRights.join(" ");
    }

    const opfMetadataDescription =
        opf.Metadata?.DCMetadata?.Description?.length ?
            opf.Metadata.DCMetadata.Description :
            (opf.Metadata?.Description?.length ?
                opf.Metadata.Description :
                undefined);
    if (opfMetadataDescription) {
        publication.Metadata.Description = opfMetadataDescription[0];
    }

    const opfMetadataPublisher =
        opf.Metadata?.DCMetadata?.Publisher?.length ?
            opf.Metadata.DCMetadata.Publisher :
            (opf.Metadata?.Publisher?.length ?
                opf.Metadata.Publisher :
                undefined);
    if (opfMetadataPublisher) {
        publication.Metadata.Publisher = [];

        opfMetadataPublisher.forEach((pub) => {
            const contrib = new Contributor();
            contrib.Name = pub;
            publication.Metadata.Publisher.push(contrib);
        });
    }

    const opfMetadataSource =
        opf.Metadata?.DCMetadata?.Source?.length ?
            opf.Metadata.DCMetadata.Source :
            (opf.Metadata?.Source?.length ?
                opf.Metadata.Source :
                undefined);
    if (opfMetadataSource) {
        publication.Metadata.Source = opfMetadataSource[0];
    }

    const opfMetadataContributor =
        opf.Metadata?.DCMetadata?.Contributor?.length ?
            opf.Metadata.DCMetadata.Contributor :
            (opf.Metadata?.Contributor?.length ?
                opf.Metadata.Contributor :
                undefined);
    if (opfMetadataContributor) {
        opfMetadataContributor.forEach((cont) => {
            addContributor(publication, rootfile, opf, cont, undefined);
        });
    }

    const opfMetadataCreator =
        opf.Metadata?.DCMetadata?.Creator?.length ?
            opf.Metadata.DCMetadata.Creator :
            (opf.Metadata?.Creator?.length ?
                opf.Metadata.Creator :
                undefined);
    if (opfMetadataCreator) {
        opfMetadataCreator.forEach((cont) => {
            addContributor(publication, rootfile, opf, cont, "aut");
        });
    }

    if (opf.Metadata?.Link) {
        opf.Metadata.Link.forEach((metaLink) => {
            if (metaLink.Property === "a11y:certifierCredential") {
                let val = metaLink.Href;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                if (!publication.Metadata.CertifierCredential) {
                    publication.Metadata.CertifierCredential = [];
                }
                publication.Metadata.CertifierCredential.push(val);
            } else if (metaLink.Property === "a11y:certifierReport") {
                let val = metaLink.Href;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                if (!publication.Metadata.CertifierReport) {
                    publication.Metadata.CertifierReport = [];
                }
                publication.Metadata.CertifierReport.push(val);
            } else if (metaLink.Property === "dcterms:conformsTo") {
                let val = metaLink.Href;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                if (!publication.Metadata.ConformsTo) {
                    publication.Metadata.ConformsTo = [];
                }
                publication.Metadata.ConformsTo.push(val);
            }
        });
    }
    if (opf.Metadata.Meta || opf.Metadata.XMetadata.Meta) {

        interface IMetaTagValue {
            metaTag: Metafield;
            val: string;
        }
        const AccessibilitySummarys: IMetaTagValue[] = [];

        const metaFunc = (metaTag: Metafield) => {
            if (metaTag.Name === "schema:accessMode" ||
                metaTag.Property === "schema:accessMode") {
                let val = metaTag.Property ? metaTag.Data : metaTag.Content;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                if (!publication.Metadata.AccessMode) {
                    publication.Metadata.AccessMode = [];
                }
                publication.Metadata.AccessMode.push(val);
            } else if (metaTag.Name === "schema:accessibilityFeature" ||
                metaTag.Property === "schema:accessibilityFeature") {
                let val = metaTag.Property ? metaTag.Data : metaTag.Content;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                if (!publication.Metadata.AccessibilityFeature) {
                    publication.Metadata.AccessibilityFeature = [];
                }
                publication.Metadata.AccessibilityFeature.push(val);
            } else if (metaTag.Name === "schema:accessibilityHazard" ||
                metaTag.Property === "schema:accessibilityHazard") {
                let val = metaTag.Property ? metaTag.Data : metaTag.Content;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                if (!publication.Metadata.AccessibilityHazard) {
                    publication.Metadata.AccessibilityHazard = [];
                }
                publication.Metadata.AccessibilityHazard.push(val);
            } else if (metaTag.Name === "schema:accessibilitySummary" ||
                metaTag.Property === "schema:accessibilitySummary") {
                let val = metaTag.Property ? metaTag.Data : metaTag.Content;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                AccessibilitySummarys.push({
                    metaTag,
                    val,
                });
            } else if (metaTag.Name === "schema:accessModeSufficient" ||
                metaTag.Property === "schema:accessModeSufficient") {
                let val = metaTag.Property ? metaTag.Data : metaTag.Content;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                if (!publication.Metadata.AccessModeSufficient) {
                    publication.Metadata.AccessModeSufficient = [];
                }
                publication.Metadata.AccessModeSufficient.push(DelinearizeAccessModeSufficient(val));
            } else if (metaTag.Name === "schema:accessibilityAPI" ||
                metaTag.Property === "schema:accessibilityAPI") {
                let val = metaTag.Property ? metaTag.Data : metaTag.Content;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                if (!publication.Metadata.AccessibilityAPI) {
                    publication.Metadata.AccessibilityAPI = [];
                }
                publication.Metadata.AccessibilityAPI.push(val);
            } else if (metaTag.Name === "schema:accessibilityControl" ||
                metaTag.Property === "schema:accessibilityControl") {
                let val = metaTag.Property ? metaTag.Data : metaTag.Content;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                if (!publication.Metadata.AccessibilityControl) {
                    publication.Metadata.AccessibilityControl = [];
                }
                publication.Metadata.AccessibilityControl.push(val);
            } else if (metaTag.Name === "a11y:certifiedBy" ||
                metaTag.Property === "a11y:certifiedBy") {
                let val = metaTag.Property ? metaTag.Data : metaTag.Content;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                if (!publication.Metadata.CertifiedBy) {
                    publication.Metadata.CertifiedBy = [];
                }
                publication.Metadata.CertifiedBy.push(val);
            } else if (metaTag.Name === "a11y:certifierCredential" || // may be link in EPUB3
                metaTag.Property === "a11y:certifierCredential") {
                let val = metaTag.Property ? metaTag.Data : metaTag.Content;
                if (!val) {
                    return; // continue
                }
                val = val.trim();
                if (!val) {
                    return; // continue
                }
                if (!publication.Metadata.CertifierCredential) {
                    publication.Metadata.CertifierCredential = [];
                }
                publication.Metadata.CertifierCredential.push(val);
            }
        };

        if (opf.Metadata.Meta) {
            opf.Metadata.Meta.forEach(metaFunc);
        }
        if (opf.Metadata.XMetadata.Meta) {
            opf.Metadata.XMetadata.Meta.forEach(metaFunc);
        }

        if (AccessibilitySummarys.length === 1) {
            const tuple = AccessibilitySummarys[0];
            if (tuple.metaTag.Lang) {
                publication.Metadata.AccessibilitySummary = {} as IStringMap;
                // tslint:disable-next-line: max-line-length
                (publication.Metadata.AccessibilitySummary as IStringMap)[tuple.metaTag.Lang.toLowerCase()] = tuple.val;
            } else {
                publication.Metadata.AccessibilitySummary = tuple.val;
            }
        } else if (AccessibilitySummarys.length) {
            publication.Metadata.AccessibilitySummary = {} as IStringMap;

            AccessibilitySummarys.forEach((tuple) => {
                // https://github.com/readium/architecture/blob/master/streamer/parser/metadata.md#title
                const xmlLang: string = tuple.metaTag.Lang || opf.Lang;
                if (xmlLang) {
                    // tslint:disable-next-line: max-line-length
                    (publication.Metadata.AccessibilitySummary as IStringMap)[xmlLang.toLowerCase()] = tuple.val;
                } else if (publication.Metadata.Language &&
                    publication.Metadata.Language.length &&
                    // tslint:disable-next-line: max-line-length
                    !(publication.Metadata.AccessibilitySummary as IStringMap)[publication.Metadata.Language[0].toLowerCase()]) {
                    // tslint:disable-next-line: max-line-length
                    (publication.Metadata.AccessibilitySummary as IStringMap)[publication.Metadata.Language[0].toLowerCase()] = tuple.val;
                } else {
                    // tslint:disable-next-line: no-string-literal, max-line-length
                    (publication.Metadata.AccessibilitySummary as IStringMap)[BCP47_UNKNOWN_LANG] = tuple.val;
                }
            });
        }

        const metasDuration: Metafield[] = [];
        const metasNarrator: Metafield[] = [];
        const metasActiveClass: Metafield[] = [];
        const metasPlaybackActiveClass: Metafield[] = [];

        const mFunc = (metaTag: Metafield) => {

            if (metaTag.Name === "dtb:totalTime") {
                metasDuration.push(metaTag);
            }

            if (metaTag.Name === "dtb:multimediaType" || // audioFullText
                metaTag.Name === "dtb:multimediaContent") { // audio,text

                if (!publication.Metadata.AdditionalJSON) {
                    publication.Metadata.AdditionalJSON = {};
                }
                publication.Metadata.AdditionalJSON[metaTag.Name] = metaTag.Content;
            }

            if (metaTag.Property === "media:duration" && !metaTag.Refine) {
                metasDuration.push(metaTag);
            }
            if (metaTag.Property === "media:narrator") {
                metasNarrator.push(metaTag);
            }
            if (metaTag.Property === "media:active-class") {
                metasActiveClass.push(metaTag);
            }
            if (metaTag.Property === "media:playback-active-class") {
                metasPlaybackActiveClass.push(metaTag);
            }
        };
        if (opf.Metadata.Meta) {
            opf.Metadata.Meta.forEach(mFunc);
        }
        if (opf.Metadata.XMetadata.Meta) {
            opf.Metadata.XMetadata.Meta.forEach(mFunc);
        }

        if (metasDuration.length) {
            publication.Metadata.Duration = timeStrToSeconds(
                metasDuration[0].Property ? metasDuration[0].Data : metasDuration[0].Content);
        }

        if (metasNarrator.length) {
            if (!publication.Metadata.Narrator) {
                publication.Metadata.Narrator = [];
            }
            metasNarrator.forEach((metaNarrator) => {
                const cont = new Contributor();
                cont.Name = metaNarrator.Data;
                publication.Metadata.Narrator.push(cont);
            });
        }
        if (metasActiveClass.length) {
            if (!publication.Metadata.MediaOverlay) {
                publication.Metadata.MediaOverlay = new MediaOverlay();
            }
            publication.Metadata.MediaOverlay.ActiveClass = metasActiveClass[0].Data;
        }
        if (metasPlaybackActiveClass.length) {
            if (!publication.Metadata.MediaOverlay) {
                publication.Metadata.MediaOverlay = new MediaOverlay();
            }
            publication.Metadata.MediaOverlay.PlaybackActiveClass = metasPlaybackActiveClass[0].Data;
        }
    }
};

export const loadFileStrFromZipPath = async (
    linkHref: string, linkHrefDecoded: string, zip: IZip): Promise<string | undefined> => {

    let zipData: Buffer | undefined;
    try {
        zipData = await loadFileBufferFromZipPath(linkHref, linkHrefDecoded, zip);
    } catch (err) {
        debug(err);
        return Promise.reject(err);
    }
    if (zipData) {
        return zipData.toString("utf8");
    }
    return Promise.reject("?!zipData loadFileStrFromZipPath()");
};

export const loadFileBufferFromZipPath = async (
    linkHref: string, linkHrefDecoded: string, zip: IZip): Promise<Buffer | undefined> => {

    if (!linkHrefDecoded) {
        debug("!?link.HrefDecoded");
        return undefined;
    }
    const has = await zipHasEntry(zip, linkHrefDecoded, linkHref);
    if (!has) {
        debug(`NOT IN ZIP (loadFileBufferFromZipPath): ${linkHref} --- ${linkHrefDecoded}`);
        const zipEntries = await zip.getEntries();
        for (const zipEntry of zipEntries) {
            debug(zipEntry);
        }
        return undefined;
    }

    let zipStream_: IStreamAndLength;
    try {
        zipStream_ = await zip.entryStreamPromise(linkHrefDecoded);
    } catch (err) {
        debug(err);
        return Promise.reject(err);
    }
    const zipStream = zipStream_.stream;

    let zipData: Buffer;
    try {
        zipData = await streamToBufferPromise(zipStream);
    } catch (err) {
        debug(err);
        return Promise.reject(err);
    }

    return zipData;
};

const fillLandmarksFromGuide = (publication: Publication, opf: OPF) => {
    if (opf.Guide && opf.Guide.length) {
        opf.Guide.forEach((ref) => {
            if (ref.Href && opf.ZipPath) {
                const refHrefDecoded = ref.HrefDecoded;
                if (!refHrefDecoded) {
                    debug("ref.Href?!");
                    return; // foreach
                }
                const link = new Link();
                const zipPath = path.join(path.dirname(opf.ZipPath), refHrefDecoded)
                    .replace(/\\/g, "/");

                link.setHrefDecoded(zipPath);

                link.Title = ref.Title;
                if (!publication.Landmarks) {
                    publication.Landmarks = [];
                }
                publication.Landmarks.push(link);
            }
        });
    }
};

const fillTOCFromNCX = (publication: Publication, ncx: NCX) => {
    if (ncx.Points && ncx.Points.length) {
        ncx.Points.forEach((point) => {
            if (!publication.TOC) {
                publication.TOC = [];
            }
            fillTOCFromNavPoint(publication, ncx, point, publication.TOC);
        });
    }
};

const fillTOCFromNavPoint =
    (publication: Publication, ncx: NCX, point: NavPoint, node: Link[]) => {

        const srcDecoded = point.Content.SrcDecoded;
        if (!srcDecoded) {
            debug("?!point.Content.Src");
            return;
        }
        const link = new Link();
        const zipPath = path.join(path.dirname(ncx.ZipPath), srcDecoded)
            .replace(/\\/g, "/");

        link.setHrefDecoded(zipPath);

        link.Title = point.Text;

        if (point.Points && point.Points.length) {
            point.Points.forEach((p) => {
                if (!link.Children) {
                    link.Children = [];
                }
                fillTOCFromNavPoint(publication, ncx, p, link.Children);
            });
        }

        node.push(link);
    };

const fillPageListFromNCX = (publication: Publication, ncx: NCX) => {
    if (ncx.PageList && ncx.PageList.PageTarget && ncx.PageList.PageTarget.length) {
        ncx.PageList.PageTarget.forEach((pageTarget) => {
            const link = new Link();
            const srcDecoded = pageTarget.Content.SrcDecoded;
            if (!srcDecoded) {
                debug("!?srcDecoded");
                return; // foreach
            }
            const zipPath = path.join(path.dirname(ncx.ZipPath), srcDecoded)
                .replace(/\\/g, "/");

            link.setHrefDecoded(zipPath);

            link.Title = pageTarget.Text;
            if (!publication.PageList) {
                publication.PageList = [];
            }
            publication.PageList.push(link);
        });
    }
};

export const fillTOC = (publication: Publication, opf: OPF, ncx: NCX | undefined) => {

    if (ncx) {
        fillTOCFromNCX(publication, ncx);
        if (!publication.PageList) {
            fillPageListFromNCX(publication, ncx);
        }
    }
    fillLandmarksFromGuide(publication, opf);
};

export const addMediaOverlaySMIL = async (link: Link, manItemSmil: Manifest, opf: OPF, zip: IZip) => {

    if (manItemSmil && manItemSmil.MediaType && manItemSmil.MediaType.startsWith("application/smil")) {
        if (opf.ZipPath) {
            const manItemSmilHrefDecoded = manItemSmil.HrefDecoded;
            if (!manItemSmilHrefDecoded) {
                debug("!?manItemSmil.HrefDecoded");
                return;
            }
            const smilFilePath = path.join(path.dirname(opf.ZipPath), manItemSmilHrefDecoded)
                .replace(/\\/g, "/");

            const has = await zipHasEntry(zip, smilFilePath, smilFilePath);
            if (!has) {
                debug(`NOT IN ZIP (addMediaOverlay): ${smilFilePath}`);
                const zipEntries = await zip.getEntries();
                for (const zipEntry of zipEntries) {
                    debug(zipEntry);
                }
                return;
            }

            const mo = new MediaOverlayNode();
            mo.SmilPathInZip = smilFilePath;
            mo.initialized = false;
            link.MediaOverlays = mo;

            const moURL = mediaOverlayURLPath + "?" +
                mediaOverlayURLParam + "=" +
                encodeURIComponent_RFC3986(link.HrefDecoded ? link.HrefDecoded : link.Href);

            // legacy method:
            if (!link.Properties) {
                link.Properties = new Properties();
            }
            link.Properties.MediaOverlay = moURL;

            // new method:
            // https://w3c.github.io/sync-media-pub/incorporating-synchronized-narration.html#with-webpub
            if (!link.Alternate) {
                link.Alternate = [];
            }
            const moLink = new Link();
            moLink.Href = moURL;
            moLink.TypeLink = "application/vnd.syncnarr+json";
            moLink.Duration = link.Duration;
            link.Alternate.push(moLink);

            if (link.Properties && link.Properties.Encrypted) {
                debug("ENCRYPTED SMIL MEDIA OVERLAY: " + (link.HrefDecoded ? link.HrefDecoded : link.Href));
            }
            // LAZY
            // await lazyLoadMediaOverlays(publication, mo);
        }
    }
};