<template>
  <Modal class="script-library" name="scriptLibrary" v-if="modals.scriptLibrary" @close="close">
    <div class="sl-head">
      <h3>剧本库</h3>
      <label class="sl-select sl-source">
        <span class="sl-select-label">剧本库来源</span>
        <select v-model="sourceLib" @change="onSourceChange">
          <option value="group">群友</option>
          <option value="yupi">鱼皮</option>
        </select>
      </label>
      <span class="sl-sub">{{ sourceSub }}</span>
    </div>

    <!-- 搜索 -->
    <label class="sl-search">
      <font-awesome-icon icon="search" class="sl-search-icon" />
      <input
        type="text"
        v-model="keyword"
        placeholder="搜索剧本、作者、角色…"
        @input="onSearchInput"
      />
      <font-awesome-icon
        v-if="loadingList"
        icon="spinner"
        spin
        class="sl-search-icon sl-loading"
      />
    </label>
    <p class="sl-hint" v-if="sourceLib === 'group'">空格分隔多个关键词 · #角色名 精确匹配</p>
    <p class="sl-hint" v-else>数据来自 ran.dogyupi.com 鱼皮剧本库 · 支持空格分隔多个关键词</p>

    <!-- 快捷筛选（仅 7uuu 剧本库） -->
    <div class="sl-quick" v-if="sourceLib === 'group'">
      <label class="sl-select sl-quick-status">
        <span class="sl-select-label">可用状态</span>
        <select v-model="availability">
          <option value="">全部状态</option>
          <option value="ready">可直接开局</option>
          <option value="reference">仅供资料参考</option>
          <option value="blocked">导入待修复</option>
          <option value="unchecked">尚未验证</option>
        </select>
      </label>
      <button
        type="button"
        class="sl-toggle"
        :class="{ on: quickPictures }"
        :aria-pressed="String(quickPictures)"
        @click="quickPictures = !quickPictures"
      >
        有图片
      </button>
      <button
        type="button"
        class="sl-toggle"
        :class="{ on: quickFavorites }"
        :aria-pressed="String(quickFavorites)"
        @click="quickFavorites = !quickFavorites"
      >
        已收藏
      </button>
      <label class="sl-select sl-quick-players">
        <span class="sl-select-label">人数初筛</span>
        <select v-model="playerCount">
          <option value="">不限人数</option>
          <option v-for="n in playerOptions" :key="n" :value="String(n)">
            {{ n }} 人
          </option>
        </select>
      </label>
      <label class="sl-select sl-quick-author">
        <span class="sl-select-label">作者</span>
        <select v-model="authorFilter">
          <option value="">不限作者</option>
          <option value="museum">博物馆</option>
        </select>
      </label>
    </div>

    <!-- 更多筛选（仅 7uuu 剧本库） -->
    <div class="sl-advanced" :class="{ open: more }" v-if="sourceLib === 'group'">
      <button type="button" class="sl-adv-toggle" @click="more = !more">
        <span>更多筛选 <span class="sl-adv-hint">阵营、分类、人数</span></span>
        <span class="sl-adv-caret">{{ more ? "▴" : "▾" }}</span>
      </button>
      <div class="sl-adv-body" v-if="more">
        <div class="sl-filter-fields">
          <label>
            排序方式
            <select v-model="sort">
              <option value="name">按名称</option>
              <option value="size">按角色数</option>
              <option value="author">按作者</option>
              <option value="played">最近游玩</option>
            </select>
          </label>
          <label>
            包含阵营
            <select v-model="team">
              <option value="">不限阵营</option>
              <option value="townsfolk">镇民</option>
              <option value="outsider">外来者</option>
              <option value="minion">爪牙</option>
              <option value="demon">恶魔</option>
              <option value="traveller">旅行者</option>
              <option value="fabled">传奇角色</option>
              <option value="loric">奇遇角色</option>
            </select>
          </label>
          <label class="sl-num">
            最少角色数
            <input type="number" min="0" placeholder="不限" v-model="minc" />
          </label>
          <label class="sl-num">
            最多角色数
            <input type="number" min="0" placeholder="不限" v-model="maxc" />
          </label>
          <label class="sl-check">
            <input type="checkbox" v-model="onlypic" />
            只看有剧照
          </label>
        </div>

        <section class="sl-category">
          <div class="sl-controls">
            <label v-for="lv in categoryLevels" :key="lv.level" class="sl-select">
              <span class="sl-select-label">{{ lv.label }}</span>
              <select
                :value="lv.value"
                @change="pickCategoryLevel(lv.level, $event.target.value)"
              >
                <option value="">{{ lv.allLabel }}（{{ lv.allCount }}）</option>
                <option v-for="o in lv.options" :key="o.path" :value="o.path">
                  {{ o.label }}（{{ o.count }}）
                </option>
              </select>
            </label>
          </div>
          <div class="sl-catsummary">{{ categorySummary }}</div>
          <small>分类数量为全库统计；可停留在任意一级，再结合关键词筛选。</small>
        </section>

        <section class="sl-workspace-bar">
          <select v-model="completion" aria-label="完整度">
            <option value="">全部完整度</option>
            <option value="complete">JSON 与正背面齐全</option>
            <option value="missing-json">缺 JSON</option>
            <option value="missing-front">缺正面</option>
            <option value="missing-back">缺背面</option>
            <option value="ancillary">仅附图或未分类</option>
            <option value="missing-images">无原图</option>
            <option value="incomplete">待补全</option>
          </select>
          <select v-model="personal" aria-label="个人记录">
            <option value="">全部个人状态</option>
            <option value="any">我的全部记录</option>
            <option value="favorite">已收藏</option>
          </select>
        </section>

        <button type="button" class="sl-results-btn" @click="more = false">
          查看结果
        </button>
    </div>
    </div>

    <!-- 错误 -->
    <p v-if="error" class="sl-error">{{ error }}</p>

    <!-- 最近导入 -->
    <div class="sl-recent" v-if="sourceLib === 'group' && recent.length && !keyword && !category">
      <span class="sl-filter-label">最近导入</span>
      <button
        v-for="r in recent"
        :key="r.index + '_' + r.name"
        class="sl-chip sl-recent-item"
        :disabled="!!pickingKey"
        @click="pickRecent(r)"
        :title="r.name"
      >
        {{ r.name }}
      </button>
    </div>

    <!-- 列表 -->
    <p class="sl-count">{{ countText }}</p>

    <ul class="sl-list" v-if="!loadingList || filtered.length">
      <li v-for="item in visible" :key="item.key">
        <button
          class="sl-card"
          :class="{ picking: pickingKey === item.key }"
          :disabled="!!pickingKey"
          @click="pickScript(item)"
        >
          <img
            class="sl-logo"
            :src="item.logo || defaultLogo"
            alt=""
            loading="eager"
            @error="onLogoError(item)"
          />
          <span class="sl-info">
            <span class="sl-name-row">
              <b class="sl-name">{{ item.name }}</b>
              <span
                v-if="item.type === 'url'"
                class="sl-badge sl-badge-url"
                >仅外链</span
              >
              <span
                v-else-if="item.health === 'blocked'"
                class="sl-badge sl-badge-blocked"
                >待修复</span
              >
              <font-awesome-icon
                v-if="pickingKey === item.key"
                icon="spinner"
                spin
                class="sl-pick-spin"
              />
            </span>
            <span class="sl-meta">
              <span v-if="item.author">{{ item.author }}</span>
              <span>{{ item.charCount }} 个角色</span>
              <span v-if="item.category" class="sl-ver sl-cat" :title="item.category">{{
                item.category
              }}</span>
            </span>
            <span class="sl-pills">
              <span
                v-for="p in item.pills"
                :key="p.team"
                class="sl-pill"
                :class="'sl-pill-' + p.team"
                >{{ p.label }}{{ p.count }}</span
              >
              <span v-if="item.picCount" class="sl-pill sl-pill-pic"
                >剧本图{{ item.picCount }}</span
              >
              <span
                v-if="item.picState !== 'complete'"
                class="sl-pill sl-pill-warn"
                >{{ picStateLabel(item.picState) }}</span
              >
            </span>
          </span>
          <span
            class="sl-fav"
            :class="{ on: isFavorite(item) }"
            :title="isFavorite(item) ? '取消收藏' : '收藏'"
            role="button"
            tabindex="0"
            @click.stop="toggleFavorite(item)"
            @keydown.enter.stop="toggleFavorite(item)"
          >
            <font-awesome-icon icon="star" />
          </span>
        </button>
      </li>
    </ul>

    <div class="sl-more" v-if="sourceLib === 'group' && visible.length < filtered.length">
      <button class="sl-more-btn" @click="loadMore">加载更多（{{ filtered.length - visible.length }}）</button>
    </div>
    <div class="sl-more" v-if="sourceLib === 'yupi' && yupiItems.length < yupiTotal">
      <button class="sl-more-btn" :disabled="yupiLoading" @click="loadMore">
        {{ yupiLoading ? "加载中…" : `加载更多（剩余 ${yupiTotal - yupiItems.length}）` }}
      </button>
    </div>
    <p v-else-if="!loadingList && !yupiLoading && filtered.length === 0" class="sl-empty">
      没有匹配的剧本
    </p>

    <div class="sl-actions">
      <button class="sl-back" @click="close">
        <font-awesome-icon icon="undo" /> 返回
      </button>
    </div>
  </Modal>
</template>

<script>
import Modal from "./Modal";
import { mapState, mapMutations } from "vuex";

// 7uuu.me 钟楼剧本库：静态资源地址（数据实时来自对方服务器，不落本地）
const CATALOG_URL = "https://7uuu.me/script_lib/assets/data/catalog.js";
const FULL_URL = "https://7uuu.me/script_lib/assets/scripts-full.js";
// 剧本图片的压缩预览清单（key = 版本/文件名，value = {file:"<24位hex>.webp"}）。
// 原站列表缩略图就是从这里取 —— 原图库有防盗链，预览图才可直接显示。
const PREVIEWS_MANIFEST_URL = "https://7uuu.me/script_lib/assets/data/image-previews.js";
const PREVIEWS_BASE = "https://7uuu.me/script_lib/assets/previews/";
const PAGE_SIZE = 30;

// 懒加载预览清单（整个页面只注入一次）
let previewsPromise = null;
function loadPreviewsManifest() {
  if (window.ScriptImagePreviews && window.ScriptImagePreviews.entries) {
    return Promise.resolve(window.ScriptImagePreviews);
  }
  if (previewsPromise) return previewsPromise;
  previewsPromise = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = PREVIEWS_MANIFEST_URL + "?t=" + Date.now();
    el.async = true;
    el.dataset.tslib = "previews";
    el.onload = () => resolve(window.ScriptImagePreviews || { entries: {} });
    el.onerror = () => {
      previewsPromise = null;
      reject(new Error("剧本缩略图清单加载失败"));
    };
    document.head.appendChild(el);
  });
  return previewsPromise;
}

// 7uuu SCRIPTS 每项字段下标（见 catalog.js 结构）：
// 0 名称 1 作者 2 分类路径 3 磁盘相对路径 4 人数 5 角色id下标数组
// 6 类型(json/url) 7 "" 8 外链url 9 版本 10 图片文件名 11 {front,back}
// 12 {sources,aliases,family,content,roster,original,importHealth}
const F_NAME = 0;
const F_AUTHOR = 1;
const F_CAT = 2;
const F_TYPE = 6;
const F_ROSTER = 5;
const F_URL = 8;
const F_VERSION = 9;
const F_IMAGES = 10;
const F_SIDES = 11;
const F_META = 12;

// 阵营中文名与展示顺序（对应 7uuu 的 TEAMCN / TEAMORD）
const TEAM_CN = {
  townsfolk: "镇民",
  outsider: "外来者",
  minion: "爪牙",
  demon: "恶魔",
  traveller: "旅行者",
  fabled: "传奇",
  loric: "奇遇"
};
const TEAM_ORDER = [
  "townsfolk",
  "outsider",
  "minion",
  "demon",
  "traveller",
  "fabled",
  "loric"
];
// 7uuu 标准阵营配置：人数 -> [镇民, 外来者, 爪牙, 恶魔]
const PLAYER_SETUPS = {
  7: [5, 0, 1, 1],
  8: [5, 1, 1, 1],
  9: [5, 2, 1, 1],
  10: [7, 0, 2, 1],
  11: [7, 1, 2, 1],
  12: [7, 2, 2, 1],
  13: [9, 0, 3, 1],
  14: [9, 1, 3, 1],
  15: [9, 2, 3, 1]
};
const FAV_KEY = "scriptLibraryFavorites";

// 规则类条目（jinx / 旅行者规则 / token）不计入角色
function isRuleTeam(team) {
  return /jinx|bootleg[\s_-]*rule|^token$/i.test(team || "");
}
// 阵营别名归一（7uuu normalizeTeam）
function normTeam(team) {
  const t = team || "";
  if (t === "traveler") return "traveller";
  return t;
}

export default {
  components: { Modal },
  data() {
    return {
      keyword: "",
      category: "",
      // 剧本库来源：group = 7uuu.me（群友整理），yupi = ran.dogyupi.com（鱼皮）
      sourceLib: "group",
      yupiItems: [],
      yupiTotal: 0,
      yupiLoading: false,
      // 快捷筛选
      availability: "",
      quickPictures: false,
      quickFavorites: false,
      playerCount: "",
      playerOptions: [7, 8, 9, 10, 11, 12, 13, 14, 15],
      // 作者（来源账号）："" = 不限作者，"museum" = 博物馆（7uuu 从 B 站「钟楼剧本博物馆」自动同步的图文剧本）
      authorFilter: "",
      // 更多筛选
      more: false,
      sort: "name",
      team: "",
      minc: "",
      maxc: "",
      onlypic: false,
      completion: "",
      personal: "",
      // 其他
      loadingList: false,
      loadingFull: false,
      error: "",
      pickingKey: "",
      version: 0, // 触发重新计算
      page: 1,
      recent: [], // 最近导入：[{index,name}]
      favorites: {} // 收藏：{ [index]: true }
    };
  },
  computed: {
    ...mapState(["modals"]),
    // 原始目录数组（来自 window.SCRIPTS）
    rawScripts() {
      this.version; // 依赖 version，触发重算
      return Array.isArray(window.SCRIPTS) ? window.SCRIPTS : [];
    },
    // 角色表（catalog.js 的 CHARS：[[名称, 阵营, 页面], …]）
    chars() {
      this.version;
      return Array.isArray(window.CHARS) ? window.CHARS : [];
    },
    // 归一化后的剧本项
    items() {
      const arr = this.rawScripts;
      const chars = this.chars;
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (!Array.isArray(s)) continue;
        const meta = s[F_META] || {};
        const type = s[F_TYPE] || "json";
        // 可用状态（对应 7uuu libraryImportHealth）
        let health;
        if (type !== "json") {
          health = "reference";
        } else {
          const st = meta.importHealth && meta.importHealth.state;
          health = st === "ready" || st === "blocked" ? st : "unchecked";
        }
        // 剧本图：正/背面（对应 pictureCompleteness）
        const files = Array.isArray(s[F_IMAGES]) ? s[F_IMAGES] : [];
        const sides = s[F_SIDES] || {};
        const has = f => !!f && files.indexOf(f) >= 0;
        const front = has(sides.front);
        const back = has(sides.back);
        // 与原站一致：剧本图数量 = 已确认的正面 + 背面（最多 2 张），
        // 而不是图片文件总数（一本剧本可能附带多张备用图）。
        const imgTotal = files.length;
        const picCount = (front ? 1 : 0) + (back ? 1 : 0);
        const picState = front && back
          ? "complete"
          : front
          ? "missing-back"
          : back
          ? "missing-front"
          : imgTotal
          ? "ancillary"
          : "missing-images";
        // 列表缩略图：照抄原站 —— 从预览清单里按 front → back → logo → 其它图片 取第一张可用的
        // 原图库有防盗链，这里改用对方的压缩预览图（webp）；走本站代理再保险一层，
        // 失败时 onLogoError 会退回直连地址。没有可用图时模板显示占位图标。
        const previewEntries =
          (window.ScriptImagePreviews && window.ScriptImagePreviews.entries) || null;
        let logo = "";
        let logoDirect = "";
        if (previewEntries) {
          const verKey = String(s[F_VERSION] || "").replace(/\\/g, "/");
          const candidates = [sides.front, sides.back, sides.logo, ...files];
          const used = new Set();
          for (const file of candidates) {
            if (!file || used.has(file)) continue;
            used.add(file);
            const entry =
              previewEntries[verKey + "/" + file] ||
              previewEntries[s[F_VERSION] + "/" + file];
            if (entry && entry.file) {
              logoDirect = PREVIEWS_BASE + entry.file;
              logo = "/api/fetch-image?url=" + encodeURIComponent(logoDirect);
              break;
            }
          }
        }
        // 角色统计与名称（排除 jinx / token 之类规则条目）
        const roster = Array.isArray(s[F_ROSTER]) ? s[F_ROSTER] : [];
        const teamCount = {};
        const names = new Set();
        const seen = new Set();
        for (const idx of roster) {
          const c = chars[idx];
          if (!c) continue;
          const t = normTeam(c[1]);
          if (isRuleTeam(t)) continue;
          const key = t + "|" + c[0];
          if (seen.has(key)) continue;
          seen.add(key);
          teamCount[t] = (teamCount[t] || 0) + 1;
          if (c[0]) names.add(String(c[0]).normalize("NFKC").trim().toLowerCase());
        }
        const charCount = Object.keys(teamCount).reduce(
          (n, t) => n + teamCount[t],
          0
        );
        const name = (s[F_NAME] || "").replace(/^#/, "").trim();
        const author = s[F_AUTHOR] || "";
        const category = s[F_CAT] || "";
        // 博物馆：7uuu 从 B 站「钟楼剧本博物馆」自动同步的图文剧本
        // （分类为「B站图文自动同步」，版本号形如 bili-cv53942036）
        const museum = category === "B站图文自动同步";
        // cv 号：同一篇文章的编号在 [3] 路径 / [8] 来源 / [9] 版本号里各出现一次，取第一个能解析到的
        const cvRaw =
          String(s[F_VERSION] || "").match(/cv(\d+)/) ||
          String(s[F_URL] || "").match(/cv(\d+)/) ||
          String(s[3] || "").match(/cv(\d+)/);
        const cv = cvRaw ? parseInt(cvRaw[1], 10) : 0;
        out.push({
          key: i,
          index: i,
          name,
          author,
          category,
          museum,
          cv,
          playerCount: charCount,
          charCount,
          teamCount,
          roleNames: names,
          searchText: (
            name +
            " " +
            author +
            " " +
            category +
            " " +
            Array.from(names).join(" ")
          ).toLowerCase(),
          type,
          url: s[F_URL] || "",
          version: s[F_VERSION] || "",
          logo,
          logoDirect,
          health,
          front,
          back,
          frontFile: front ? sides.front : "",
          backFile: back ? sides.back : "",
          imgTotal,
          picCount,
          picState,
          pills: TEAM_ORDER.filter(t => teamCount[t]).map(t => ({
            team: t,
            label: TEAM_CN[t] || t,
            count: teamCount[t]
          }))
        });
      }
      return out;
    },
    // 分类树（照抄 7uuu：categoryTree 按 " / " 分层，每个节点统计剧本数）
    categoryTree() {
      const root = { label: "", path: "", count: 0, children: {} };
      for (const it of this.items) {
        let parts = (it.category || "")
          .split(" / ")
          .map(p => p.trim())
          .filter(Boolean);
        if (!parts.length) parts = ["未分类"];
        let node = root;
        node.count++;
        for (const label of parts) {
          if (!node.children[label]) {
            node.children[label] = {
              label,
              path: node.path ? node.path + " / " + label : label,
              count: 0,
              children: {}
            };
          }
          node = node.children[label];
          node.count++;
        }
      }
      return root;
    },
    // 当前选中分类的层级切片
    categoryParts() {
      return (this.category || "")
        .split(" / ")
        .map(p => p.trim())
        .filter(Boolean);
    },
    // 逐级下拉框（大类 / 第 2 级 / …），与 7uuu 的 renderCategorySelectors 一致
    categoryLevels() {
      const levels = [];
      const selected = this.categoryParts;
      let node = this.categoryTree;
      let level = 0;
      while (Object.keys(node.children).length) {
        const opts = Object.values(node.children)
          .sort((a, b) =>
            a.label.localeCompare(b.label, "zh", { numeric: true })
          )
          .map(c => ({ label: c.label, path: c.path, count: c.count }));
        levels.push({
          level,
          label: level === 0 ? "大类" : `第 ${level + 1} 级`,
          allLabel: level === 0 ? "全部分类" : "全部子类",
          allCount: node.count,
          value:
            selected.length > level
              ? selected.slice(0, level + 1).join(" / ")
              : "",
          options: opts
        });
        const next = node.children[selected[level]];
        if (!next) break;
        node = next;
        level++;
      }
      return levels;
    },
    // 分类说明文字（对应原站 categoryPath）
    categorySummary() {
      if (!this.category) {
        return `全部分类 · ${this.categoryTree.count} 个剧本`;
      }
      let node = this.categoryTree;
      for (const p of this.categoryParts) {
        if (!node.children[p]) break;
        node = node.children[p];
      }
      return `${this.category} · 包含下级，共 ${node.count} 个剧本`;
    },
    filtered() {
      // 鱼皮剧本库：服务端分页 + 关键词，客户端只再做收藏过滤
      if (this.sourceLib === "yupi") {
        const kwTerms = this.keyword
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        const favOnly =
          this.quickFavorites || this.personal === "any" || this.personal === "favorite";
        return this.yupiItems.filter(it => {
          if (favOnly && !this.favorites[it.index]) return false;
          if (
            kwTerms.length &&
            !kwTerms.every(term => it.searchText.indexOf(term) >= 0)
          ) {
            return false;
          }
          return true;
        });
      }
      const mn = parseInt(this.minc, 10);
      const mx = parseInt(this.maxc, 10);
      const setup = PLAYER_SETUPS[this.playerCount];
      const kw = this.keyword.trim().toLowerCase();
      const kwTerms = kw ? kw.split(/\s+/).filter(Boolean) : [];
      const want = this.categoryParts;
      const needPic = this.quickPictures || this.onlypic;
      const favOnly =
        this.quickFavorites || this.personal === "any" || this.personal === "favorite";

      let list = this.items.filter(it => {
        // 作者（来源）：博物馆 = 从 B 站「钟楼剧本博物馆」自动同步的剧本
        if (this.authorFilter === "museum" && !it.museum) return false;
        // 可用状态
        if (this.availability && it.health !== this.availability) return false;
        // 完整度
        const c = this.completion;
        if (c === "missing-json" && it.type === "json") return false;
        if (c === "missing-images" && it.picState !== "missing-images")
          return false;
        if (c === "missing-front" && it.front) return false;
        if (c === "missing-back" && it.back) return false;
        if (c === "ancillary" && it.picState !== "ancillary") return false;
        if (c === "complete" && (it.type !== "json" || it.picState !== "complete"))
          return false;
        if (c === "incomplete" && it.type === "json" && it.picState === "complete")
          return false;
        // 有图片 / 只看有剧照（有任意图片即算，含仅附图的情况）
        if (needPic && !it.imgTotal) return false;
        // 人数初筛：按标准阵营配置检查可选角色数量是否够
        if (setup) {
          const ok = ["townsfolk", "outsider", "minion", "demon"].every(
            (t, i) => (it.teamCount[t] || 0) >= setup[i]
          );
          if (!ok) return false;
        }
        // 最少 / 最多角色数
        if (!isNaN(mn) && it.charCount < mn) return false;
        if (!isNaN(mx) && it.charCount > mx) return false;
        // 包含阵营
        if (this.team && !it.teamCount[this.team]) return false;
        // 关键词：#角色名 精确匹配，其余按检索串
        if (kwTerms.length) {
          const hit = kwTerms.every(term =>
            term[0] === "#"
              ? it.roleNames.has(term.slice(1))
              : it.searchText.indexOf(term) >= 0
          );
          if (!hit) return false;
        }
        // 分类前缀匹配（包含全部下级）
        if (want.length) {
          const parts = (it.category || "")
            .split(" / ")
            .map(p => p.trim())
            .filter(Boolean);
          if (parts.length < want.length) return false;
          for (let i = 0; i < want.length; i++) {
            if (parts[i] !== want[i]) return false;
          }
        }
        // 收藏
        if (favOnly && !this.favorites[it.index]) return false;
        return true;
      });

      list = list.slice();
      if (this.authorFilter === "museum") {
        // 博物馆：按 cv 号倒序（数字越大越新），不受「排序方式」影响
        list.sort((a, b) => b.cv - a.cv || a.name.localeCompare(b.name, "zh"));
      } else if (this.sort === "size") {
        list.sort(
          (a, b) =>
            b.charCount - a.charCount ||
            a.name.localeCompare(b.name, "zh-CN")
        );
      } else if (this.sort === "author") {
        list.sort(
          (a, b) =>
            (a.author || "").localeCompare(b.author || "", "zh") ||
            a.name.localeCompare(b.name, "zh")
        );
      } else {
        list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
      }
      return list;
    },
    visible() {
      if (this.sourceLib === "yupi") return this.filtered;
      return this.filtered.slice(0, this.page * PAGE_SIZE);
    },
    total() {
      return this.sourceLib === "yupi" ? this.yupiTotal : this.items.length;
    },
    sourceSub() {
      return this.sourceLib === "yupi"
        ? `数据来自 ran.dogyupi.com 鱼皮剧本库 · 共 ${this.yupiTotal} 本`
        : `数据来自 7uuu.me 钟楼剧本库 · 共 ${this.total} 本`;
    },
    countText() {
      if (this.sourceLib === "yupi") {
        if (this.yupiLoading && !this.yupiItems.length) return "加载中…";
        return `命中 ${this.filtered.length} 个剧本，已列出 ${this.filtered.length} 个（库中共 ${this.yupiTotal} 本）`;
      }
      return this.loadingList
        ? "加载中…"
        : `命中 ${this.filtered.length} / ${this.total} 个剧本，已列出 ${this.visible.length} 个`;
    },
    // 任一筛选条件变化 → 回到第 1 页
    filterSignature() {
      return JSON.stringify([
        this.keyword,
        this.category,
        this.availability,
        this.quickPictures,
        this.quickFavorites,
        this.playerCount,
        this.authorFilter,
        this.team,
        this.minc,
        this.maxc,
        this.onlypic,
        this.completion,
        this.personal
      ]);
    },
    defaultLogo() {
      // 没有可用缩略图时的占位图（与 7uuu 的“资料”占位一致的简易文档图标）
      return (
        "data:image/svg+xml;charset=utf-8," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 38">' +
            '<path d="M8 3h11l7 7v24H6V3h2Zm11 0v8h7" fill="none" stroke="#8a8a8a" stroke-width="1.6"/>' +
            '<path d="M11 17h10M11 22h10M11 27h6" stroke="#8a8a8a" stroke-width="1.6" fill="none"/>' +
            "</svg>"
        )
      );
    }
  },
  watch: {
    filterSignature() {
      this.page = 1;
    }
  },
  created() {
    this.loadRecent();
    this.loadFavorites();
    // 缩略图清单（原站列表左侧预览图的数据源）
    loadPreviewsManifest()
      .then(() => {
        this.version++;
      })
      .catch(() => {
        /* 缩略图加载失败不影响列表本身，显示占位图 */
      });
    if (!window.SCRIPTS) {
      this.loadCatalog();
    } else {
      this.version++;
    }
  },
  methods: {
    ...mapMutations(["toggleModal"]),
    close() {
      this.toggleModal("scriptLibrary");
    },
    onSearchInput() {
      this.page = 1;
      if (this.sourceLib === "yupi") {
        // 立即作废「当前在途的旧请求」：递增令牌，使其晚到的响应被丢弃，
        // 避免它把列表覆盖成上一次关键词的结果（清空搜索后仍卡旧内容的另一条路径）。
        this._yupiReqToken = (this._yupiReqToken || 0) + 1;
        clearTimeout(this._yupiTimer);
        this._yupiTimer = setTimeout(() => this.loadYupi(true), 350);
      }
    },
    // 完整度状态中文（对应 7uuu pictureStateLabel）
    picStateLabel(state) {
      return (
        {
          complete: "正背面齐全",
          "missing-back": "缺背面",
          "missing-front": "缺正面",
          ancillary: "仅附图或未分类",
          "missing-images": "缺图片"
        }[state] || ""
      );
    },
    // 收藏（localStorage 持久化，key 用剧本在目录里的下标）
    loadFavorites() {
      try {
        const raw = localStorage.getItem(FAV_KEY);
        const obj = raw ? JSON.parse(raw) : {};
        this.favorites = obj && typeof obj === "object" ? obj : {};
      } catch (e) {
        this.favorites = {};
      }
    },
    saveFavorites() {
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify(this.favorites));
      } catch (e) {
        /* 忽略存储失败 */
      }
    },
    isFavorite(item) {
      return !!this.favorites[item.index];
    },
    toggleFavorite(item) {
      const next = Object.assign({}, this.favorites);
      if (next[item.index]) {
        delete next[item.index];
      } else {
        next[item.index] = true;
      }
      this.favorites = next;
      this.saveFavorites();
    },
    pickCategory(name) {
      this.category = name;
    },
    // 第 level 级下拉被改变：截断到该级，后面的层级自动重置
    pickCategoryLevel(level, value) {
      if (!value) {
        // 选了「全部分类 / 全部子类」：保留上一级
        const parts = this.categoryParts.slice(0, level);
        this.category = parts.join(" / ");
        return;
      }
      this.category = value;
    },
    pickSort(key) {
      this.sort = key;
    },
    loadMore() {
      if (this.sourceLib === "yupi") {
        this.loadYupi(false);
        return;
      }
      this.page++;
    },
    // 切换剧本库来源
    onSourceChange() {
      this.error = "";
      this.page = 1;
      // 取消可能还在等待中的搜索防抖，避免切源后又被上一次输入触发的旧请求覆盖。
      clearTimeout(this._yupiTimer);
      // yupi 列表是服务端分页 + 服务端按 keyword 过滤的结果缓存。之前一旦搜过关键词，
      // yupiItems 里只剩「命中的子集」；切回 yupi 时若因其非空而跳过重新加载，
      // 界面就会一直卡在旧的搜索内容上（本例 bug）。
      // 因此切到 yupi 时一律清空旧缓存并按「当前 keyword」重新拉取：
      // 若搜索框已被清空，这里就是按空关键词拉全量，恢复正常列表。
      if (this.sourceLib === "yupi") {
        this.yupiItems = [];
        this.loadYupi(true);
      }
    },
    // 鱼皮剧本库：经本站 /api/dogyupi 代理转发（对方接口没有 CORS 头）
    async yupiFetch(path) {
      const res = await fetch("/api/dogyupi" + path);
      if (!res.ok) {
        throw new Error("接口返回 " + res.status);
      }
      return res.json();
    },
    // 鱼皮剧本条目 → 与 7uuu 列表一致的卡片结构
    mapYupiItem(x) {
      const category = [x.category, x.subcategory]
        .filter(Boolean)
        .join(" / ")
        .replace(/^\/\s*/, "");
      const logoDirect = x.logo || "";
      return {
        key: "yupi-" + x.id,
        index: "yupi-" + x.id,
        yupiId: x.id,
        slug: x.slug,
        name: x.name || "",
        author: x.author || "",
        category,
        charCount: x.role_count || 0,
        playerCount: x.role_count || 0,
        teamCount: {},
        roleNames: new Set(),
        searchText: (
          (x.name || "") +
          " " +
          (x.author || "") +
          " " +
          category
        ).toLowerCase(),
        type: "json",
        url: "",
        version: "",
        logo: logoDirect
          ? "/api/fetch-image?url=" + encodeURIComponent(logoDirect)
          : "",
        logoDirect,
        health: "ready",
        front: false,
        back: false,
        frontFile: "",
        backFile: "",
        imgTotal: 0,
        picCount: 0,
        picState: "complete",
        pills: []
      };
    },
    async loadYupi(reset) {
      // 只有「加载更多」(reset=false) 才需要防重入；reset=true 表示用户改动了搜索词/切了来源，
      // 必须以最新条件重新拉取，不能被一个尚未返回的旧请求挡住（否则清空搜索后仍显示旧结果）。
      if (!reset && this.yupiLoading) return;
      // 每次 reset 用递增令牌标记，返回时若令牌已过期（期间又发起了新请求）则丢弃结果，
      // 避免旧请求晚到后把新结果覆盖回「旧的搜索子集」。
      const token = reset ? (this._yupiReqToken = (this._yupiReqToken || 0) + 1) : this._yupiReqToken;
      this.yupiLoading = true;
      this.error = "";
      const offset = reset ? 0 : this.yupiItems.length;
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(offset),
        sort: "new"
      });
      // 用当前 keyword 作为请求条件（清空后即为空 → 拉全量）。
      const kw = this.keyword.trim();
      if (kw) params.set("keyword", kw);
      try {
        const data = await this.yupiFetch("/api/scripts?" + params.toString());
        // 过期响应直接丢弃，不写回 state（新请求正在路上，由它负责置回 loading）。
        if (reset && token !== this._yupiReqToken) return;
        const list = Array.isArray(data.items) ? data.items.map(x => this.mapYupiItem(x)) : [];
        this.yupiItems = reset ? list : this.yupiItems.concat(list);
        if (typeof data.total === "number") this.yupiTotal = data.total;
      } catch (e) {
        if (reset && token !== this._yupiReqToken) return;
        this.error = "鱼皮剧本库加载失败：" + (e && e.message ? e.message : e);
      }
      this.yupiLoading = false;
    },
    // 最近导入（localStorage 持久化）
    loadRecent() {
      try {
        const raw = localStorage.getItem("scriptLibraryRecent");
        const arr = raw ? JSON.parse(raw) : [];
        this.recent = Array.isArray(arr) ? arr.slice(0, 10) : [];
      } catch (e) {
        this.recent = [];
      }
    },
    recordRecent(item) {
      const list = this.recent.filter(
        r => !(r.index === item.index && r.name === item.name)
      );
      list.unshift({ index: item.index, name: item.name });
      this.recent = list.slice(0, 10);
      try {
        localStorage.setItem(
          "scriptLibraryRecent",
          JSON.stringify(this.recent)
        );
      } catch (e) {
        /* 忽略存储失败 */
      }
    },
    pickRecent(r) {
      const item = this.items[r.index];
      if (item) this.pickScript(item);
    },
    onLogoError(item) {
      // 代理失败 → 试直连预览图；直连也失败 → 空，模板显示占位图
      if (item.logoDirect && item.logo !== item.logoDirect) {
        item.logo = item.logoDirect;
      } else {
        item.logo = "";
      }
    },
    // 用 <script> 注入加载 7uuu 的 catalog.js（不受 CORS 限制）
    loadCatalog() {
      if (this.loadingList) return;
      this.loadingList = true;
      this.error = "";
      this.injectScript(CATALOG_URL, "catalog")
        .then(() => {
          this.version++;
          this.loadingList = false;
        })
        .catch(e => {
          this.loadingList = false;
          this.error = "剧本库加载失败：" + (e && e.message ? e.message : e);
        });
    },
    // 按需加载 scripts-full.js（仅当点开某剧本、需要原文时）
    loadFull() {
      if (window.SCRIPT_FULL && Array.isArray(window.SCRIPT_FULL)) {
        return Promise.resolve(window.SCRIPT_FULL);
      }
      if (this.loadingFull) {
        return this._fullPromise;
      }
      this.loadingFull = true;
      this._fullPromise = this.injectScript(FULL_URL, "full").then(() => {
        this.loadingFull = false;
        return window.SCRIPT_FULL;
      });
      this._fullPromise.catch(() => {
        this.loadingFull = false;
      });
      return this._fullPromise;
    },
    injectScript(url, tag) {
      return new Promise((resolve, reject) => {
        const el = document.createElement("script");
        el.src = url + "?t=" + Date.now();
        el.async = true;
        el.dataset.tslib = tag || "1";
        el.onload = () => resolve();
        el.onerror = () =>
          reject(new Error(tag === "full" ? "剧本原文加载失败" : "剧本目录加载失败"));
        document.head.appendChild(el);
      });
    },
    async pickScript(item) {
      if (this.pickingKey) return;
      // 鱼皮剧本库：走详情接口拿剧本 JSON
      if (this.sourceLib === "yupi") {
        this.pickingKey = item.key;
        this.error = "";
        try {
          const data = await this.yupiFetch(
            "/api/scripts/" + encodeURIComponent(item.slug)
          );
          const roles = data.payload || data.roles || data.script;
          if (!roles) throw new Error("剧本内容为空");
          this.applyScript(roles, null);
          this.recordRecent(item);
          this.pickingKey = "";
          this.toggleModal("scriptLibrary");
        } catch (e) {
          this.pickingKey = "";
          this.error = "导入失败：" + (e && e.message ? e.message : e);
        }
        return;
      }
      // 仅外链（url 类型）：直接提示不支持（避免把别人的页面当 JSON）
      if (item.type === "url") {
        this.error = "这本剧本只提供外部链接，暂不支持直接导入。";
        return;
      }
      this.pickingKey = item.key;
      this.error = "";
      try {
        const full = await this.loadFull();
        if (!Array.isArray(full) || !full[item.index]) {
          throw new Error("剧本原文与目录不匹配");
        }
        const raw = full[item.index].t;
        const roles = typeof raw === "string" ? JSON.parse(raw) : raw;
        this.applyScript(roles, item);
        this.recordRecent(item);
        this.pickingKey = "";
        this.toggleModal("scriptLibrary");
      } catch (e) {
        this.pickingKey = "";
        this.error = "导入失败：" + (e && e.message ? e.message : e);
      }
    },
    // 复用 EditionModal 的解析逻辑：把剧本角色数组应用到魔典
    applyScript(roles, item) {
      if (!roles || !roles.length) return;
      roles = roles.map(role => (typeof role === "string" ? { id: role } : role));
      const metaIndex = roles.findIndex(({ id }) => id === "_meta");
      let meta = {};
      if (metaIndex > -1) {
        meta = roles.splice(metaIndex, 1).pop();
      }
      if (meta.bootlegger) {
        for (let i = 0; i < meta.bootlegger.length; i++) {
          roles.push({
            id: `bootlegger${i}`,
            reminders: [],
            setup: false,
            name: `私货商人${i + 1}`,
            team: "fabled",
            ability: meta.bootlegger[i]
          });
        }
      }
      this.$store.commit("setCustomRoles", roles);
      // 记住剧本库来源：供「下载剧本图」按钮判断该剧本是否来自剧本库、以及正/背面图文件名
      const libraryMeta = item
        ? {
            libraryIndex: item.index,
            libraryVersion: item.version || "",
            libraryFront: item.frontFile || "",
            libraryBack: item.backFile || ""
          }
        : {};
      this.$store.commit(
        "setEdition",
        Object.assign({}, meta, libraryMeta, { id: "custom" })
      );
      if (roles.some(role => this.$store.state.fabled.has(role.id || role))) {
        const fabled = [];
        roles.forEach(role => {
          if (
            this.$store.state.fabled.has(role.id || role) &&
            (!meta.bootlegger || role.id !== "bootlegger")
          ) {
            fabled.push(this.$store.state.fabled.get(role.id || role));
          }
        });
        this.$store.commit("players/setFabled", { fabled });
      }
      // 状态
      const states = [];
      if (meta.state) {
        meta.state.forEach(state => {
          states.push({ [state.stateName]: state.stateDescription });
        });
      } else if (meta.status) {
        meta.status.forEach(state => {
          states.push({ [state.name]: state.skill });
        });
      }
      this.$store.commit("setStates", states);
      // 阵营名字
      const names = {
        townsfolk: meta.townsfolksName ? meta.townsfolksName : "镇民",
        outsider: meta.outsidersName ? meta.outsidersName : "外来者",
        minion: meta.minionsName ? meta.minionsName : "爪牙",
        demon: meta.demonsName ? meta.demonsName : "恶魔"
      };
      this.$store.commit("setTeamsNames", names);
      // 夜序
      if (!!meta.firstNight && meta.firstNight.length > 0) {
        this.$store.commit(
          "setFirstNight",
          meta.firstNight.map(r => r.toLocaleLowerCase().replace(/[^a-z0-9]/g, ""))
        );
      } else {
        this.$store.commit("setFirstNight", []);
      }
      if (!!meta.otherNight && meta.otherNight.length > 0) {
        this.$store.commit(
          "setOtherNight",
          meta.otherNight.map(r => r.toLocaleLowerCase().replace(/[^a-z0-9]/g, ""))
        );
      } else {
        this.$store.commit("setOtherNight", []);
      }
      // 换剧本 = 新开一局
      this.$store.dispatch("newGame");
    }
  }
};
</script>

<style scoped lang="scss">
$gold: #f6d66a;
$panel: rgba(0, 0, 0, 0.35);
$border: rgba(0, 0, 0, 0.9);

// 注意：class="script-library" 会被 Vue 合并到根元素 .modal-backdrop 上。
// .modal 属于 Modal.vue 的内部元素（不带本组件的 scoped 属性），
// 必须用 ::v-deep 穿透，否则 .script-library .modal[data-v-x] 匹配不到。
.script-library {
  ::v-deep .modal {
    width: 700px;
    max-width: 92vw;
    height: 74vh;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    color: #eee;
    text-align: left;
    // 整块内容（筛选区 + 列表）共用一个滚动条，避免嵌套滚动
    > .slot {
      display: block;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
    }
  }
}

.sl-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 10px;
  h3 {
    margin: 0;
    font-family: PiratesBay, sans-serif;
    letter-spacing: 1px;
    color: $gold;
  }
  .sl-sub {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.45);
  }
  .sl-source {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.7);
    select {
      // 与 .sl-quick-status 等其它表单控件统一宽度，避免默认按内容/最长 option 撑开
      width: 120px;
      min-width: 120px;
      max-width: 120px;
      flex: none;
      background: rgba(0, 0, 0, 0.4);
      color: #eee;
      border: 2px solid $border;
      border-radius: 6px;
      padding: 2px 6px;
      font-size: 12px;
    }
  }
}

.sl-search {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 2px solid $border;
  background: rgba(0, 0, 0, 0.4);
  border-radius: 6px;
  padding: 6px 10px;
  margin-bottom: 8px;
  .sl-search-icon {
    color: rgba(255, 255, 255, 0.4);
    width: 16px;
    flex: none;
  }
  .sl-loading {
    margin-left: auto;
  }
  input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: #fff;
    font-size: 14px;
    &::placeholder {
      color: rgba(255, 255, 255, 0.35);
    }
  }
}

.sl-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  .sl-filter-label {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.35);
    margin-right: 2px;
  }
}

// 搜索提示
.sl-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.32);
  margin: -2px 0 6px;
}

// 快捷筛选行
.sl-quick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  .sl-quick-status {
    flex: 0 1 200px;
  }
  .sl-quick-players {
    flex: 0 1 160px;
  }
  .sl-quick-author {
    flex: 0 1 160px;
  }
}
.sl-toggle {
  border: 2px solid $border;
  background: $panel;
  color: rgba(255, 255, 255, 0.6);
  border-radius: 6px;
  padding: 5px 12px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  &:hover {
    color: #fff;
  }
  &.on {
    border-color: $gold;
    color: $gold;
    background: rgba(246, 214, 106, 0.12);
  }
}

// 更多筛选
.sl-advanced {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.18);
  margin-bottom: 8px;
  flex: none;
  .sl-adv-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    cursor: pointer;
    padding: 6px 10px;
    font-size: 13px;
    font-family: inherit;
    color: rgba(255, 255, 255, 0.65);
    background: none;
    border: none;
    text-align: left;
    user-select: none;
    &:hover {
      color: #fff;
    }
    .sl-adv-hint {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.3);
      margin-left: 6px;
    }
    .sl-adv-caret {
      color: rgba(255, 255, 255, 0.4);
    }
  }
}
.sl-adv-body {
  padding: 0 10px 10px;
}

.sl-filter-fields {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px 10px;
  margin-bottom: 8px;
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.45);
  }
  select,
  input {
    background: rgba(0, 0, 0, 0.4);
    border: 2px solid $border;
    border-radius: 6px;
    color: #eee;
    padding: 5px 8px;
    font-size: 13px;
    outline: none;
    option {
      background: #1b1b1b;
      color: #eee;
    }
  }
  .sl-num input {
    width: 76px;
    &::placeholder {
      color: rgba(255, 255, 255, 0.25);
    }
  }
  .sl-check {
    flex-direction: row;
    align-items: center;
    gap: 5px;
    padding-bottom: 7px;
    cursor: pointer;
    input {
      width: 14px;
      height: 14px;
      padding: 0;
      accent-color: $gold;
    }
  }
}

.sl-category {
  border-top: 1px solid rgba(255, 255, 255, 0.07);
  padding-top: 8px;
  margin-bottom: 6px;
  > small {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.28);
  }
}

.sl-workspace-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
  select {
    background: rgba(0, 0, 0, 0.4);
    border: 2px solid $border;
    border-radius: 6px;
    color: #eee;
    padding: 5px 8px;
    font-size: 13px;
    outline: none;
    cursor: pointer;
    option {
      background: #1b1b1b;
      color: #eee;
    }
  }
}

.sl-results-btn {
  display: block;
  width: 100%;
  border: 2px solid rgba(246, 214, 106, 0.5);
  background: rgba(246, 214, 106, 0.1);
  color: $gold;
  border-radius: 6px;
  padding: 6px;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
  &:hover {
    background: rgba(246, 214, 106, 0.2);
  }
}

// 分类/排序下拉框
.sl-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 8px;
}
.sl-select {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1 1 200px;
  min-width: 0;
  .sl-select-label {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.45);
    flex: none;
  }
  select {
    flex: 1;
    min-width: 0;
    background: rgba(0, 0, 0, 0.4);
    color: #eee;
    border: 2px solid $border;
    border-radius: 6px;
    padding: 5px 8px;
    font-size: 13px;
    outline: none;
    cursor: pointer;
    option {
      background: #1b1b1b;
      color: #eee;
    }
  }
}
.sl-catsummary {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
  margin: 0 0 8px;
}

.sl-recent {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  .sl-filter-label {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.35);
    margin-right: 2px;
  }
  .sl-recent-item {
    max-width: 180px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
}

.sl-chip {
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: transparent;
  color: rgba(255, 255, 255, 0.55);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s;
  em {
    font-style: normal;
    opacity: 0.55;
    margin-left: 3px;
  }
  &:hover {
    color: #fff;
  }
  &.active {
    background: rgba(255, 255, 255, 0.2);
    border-color: rgba(255, 255, 255, 0.5);
    color: #fff;
  }
}

.sl-error {
  color: #ffb4b4;
  background: rgba(255, 60, 60, 0.12);
  border: 1px solid rgba(255, 60, 60, 0.4);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  margin: 6px 0;
}

.sl-count {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  margin: 4px 0 8px;
}

.sl-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 5px;
  list-style: none;
  margin: 0 0 10px;
  padding: 0 2px 0 0;
  flex: none;
  // 覆盖全局 .modal ul 的 flex/居中规则，否则 grid 列会被居中而贴不到边框
  justify-content: stretch;
  align-content: start;
  align-items: stretch;
  max-width: none;
  width: 100%;
  @media (max-width: 640px) {
    grid-template-columns: 1fr;
  }
  li {
    margin: 0;
    min-width: 0;
  }
}

.sl-card {
  display: flex;
  width: 100%;
  min-width: 0;
  overflow: hidden;
  align-items: center;
  gap: 8px;
  border: 2px solid $border;
  background: $panel;
  border-radius: 6px;
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
  transition: border-color 0.15s;
  &:hover {
    border-color: rgba($gold, 0.6);
  }
  &.picking {
    opacity: 0.6;
  }
  &:disabled {
    cursor: default;
  }
}

.sl-logo {
  width: 52px;
  height: 72px;
  flex: none;
  border-radius: 4px;
  object-fit: cover;
  background: rgba(255, 255, 255, 0.06);
}

.sl-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.sl-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}

.sl-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  color: #f7e3a8;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sl-badge {
  flex: none;
  font-size: 10px;
  padding: 0 6px;
  border-radius: 999px;
  line-height: 16px;
  border: 1px solid;
  &.sl-badge-url {
    color: rgba(255, 255, 255, 0.5);
    border-color: rgba(255, 255, 255, 0.25);
  }
  &.sl-badge-blocked {
    color: #ffd29a;
    border-color: rgba(255, 180, 90, 0.5);
  }
}

.sl-pick-spin {
  width: 12px;
  color: rgba(255, 255, 255, 0.6);
}

.sl-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.45);
  .sl-ver {
    opacity: 0.6;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 60%;
  }
  .sl-cat {
    max-width: 100%;
    flex: 1 1 100%;
  }
}

.sl-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.sl-pill {
  font-size: 10px;
  line-height: 15px;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  color: rgba(255, 255, 255, 0.6);
  white-space: nowrap;
  &.sl-pill-townsfolk {
    color: #7fa8ff;
    border-color: rgba(31, 101, 255, 0.55);
  }
  &.sl-pill-outsider {
    color: #7fdcff;
    border-color: rgba(70, 213, 255, 0.5);
  }
  &.sl-pill-minion {
    color: #ffa06a;
    border-color: rgba(255, 105, 0, 0.5);
  }
  &.sl-pill-demon {
    color: #ff8a8a;
    border-color: rgba(206, 1, 0, 0.55);
  }
  &.sl-pill-traveller,
  &.sl-pill-fabled,
  &.sl-pill-loric {
    color: #d9a7ff;
    border-color: rgba(204, 4, 255, 0.45);
  }
  &.sl-pill-pic {
    color: #b9e6a8;
    border-color: rgba(120, 200, 90, 0.4);
  }
  &.sl-pill-warn {
    color: #ffd29a;
    border-color: rgba(255, 180, 90, 0.45);
  }
}

// 收藏按钮（卡片右上角）
.sl-fav {
  flex: none;
  align-self: flex-start;
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: rgba(255, 255, 255, 0.22);
  font-size: 13px;
  transition: all 0.15s;
  cursor: pointer;
  &:hover {
    color: rgba(246, 214, 106, 0.8);
  }
  &.on {
    color: $gold;
  }
}

.sl-more {
  text-align: center;
  margin: 4px 0 10px;
}

.sl-more-btn {
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.8);
  border-radius: 6px;
  padding: 6px 16px;
  font-size: 13px;
  cursor: pointer;
  &:hover {
    background: rgba(255, 255, 255, 0.16);
  }
}

.sl-empty {
  text-align: center;
  color: rgba(255, 255, 255, 0.4);
  font-size: 13px;
  padding: 20px 0;
}

.sl-actions {
  display: flex;
  justify-content: center;
  margin-top: 6px;
  .sl-back {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: #ddd;
    border-radius: 6px;
    padding: 6px 18px;
    cursor: pointer;
    font-size: 14px;
    &:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.16);
    }
  }
}
</style>
