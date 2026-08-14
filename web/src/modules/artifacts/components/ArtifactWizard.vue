<script setup>
import { computed, nextTick, ref, watch } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import {
  ARTIFACT_RECIPES, KIND_META, composeArtifactPrompt, findRecipe, kindIcon,
} from '../artifact-view.js'
import { closeWizard, setWizardKind, startArtifactFrom, state } from '@/stores/app.js'

/**
 * 创建向导。
 *
 * **它不创建任何东西** —— 创建的是模型。这里做的是把"选一种类型 + 写一句想要什么"
 * 拼成一句话送进输入框，顺便让用户看见这个平台到底能产出哪几种东西。
 *
 * 所以最后那个按钮叫「去创作」而不是「创建」：点完看到的是一条新对话和一个
 * 填好的输入框，不是一份凭空出现的作品。名字对不上预期比少一个功能更糟。
 */
const box = ref(null)
const recipe = computed(() => findRecipe(state.wizardKind))
const preview = computed(() => composeArtifactPrompt(state.wizardKind, state.wizardDraft))
const ready = computed(() => Boolean(state.wizardDraft.trim()))

/** 换类型时把焦点送回输入框：选完类型下一步一定是写描述 */
watch(() => state.wizardKind, () => {
  nextTick(() => box.value?.focus())
})

function useExample(text) {
  state.wizardDraft = text
  nextTick(() => box.value?.focus())
}

function submit() {
  if (!ready.value) return
  startArtifactFrom(preview.value)
}

/** Ctrl/Cmd + Enter 直接走 —— 这是一个输入框，手不该被迫离开键盘 */
function onKeydown(event) {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit()
}
</script>

<template>
  <div class="mask" @click.self="closeWizard">
    <section class="wizard" role="dialog" aria-label="新建作品">
      <header>
        <h2>新建作品</h2>
        <button type="button" class="icon-btn" title="关闭（Esc）" @click="closeWizard">
          <AppIcon name="x" :size="16" />
        </button>
      </header>

      <div class="wiz-body">
        <p class="lead">
          作品由助手产出，所以这里不填表 —— 选一种类型、说一句想要什么，
          我们把话拼好放进输入框，你再改改就能发。
        </p>

        <div class="kinds">
          <button
            v-for="item in ARTIFACT_RECIPES"
            :key="item.kind"
            type="button"
            class="kind"
            :class="{ on: state.wizardKind === item.kind }"
            @click="setWizardKind(item.kind)"
          >
            <AppIcon :name="kindIcon(item.kind)" :size="16" />
            <span class="kind-name">{{ KIND_META[item.kind].label }}</span>
          </button>
        </div>

        <p v-if="recipe" class="blurb">{{ recipe.blurb }}</p>

        <label class="field">
          <span class="field-label">你想要什么？</span>
          <textarea
            ref="box"
            v-model="state.wizardDraft"
            rows="3"
            placeholder="用一两句话说清楚要什么、给谁看、有什么要求"
            @keydown="onKeydown"
          />
        </label>

        <div v-if="recipe" class="examples">
          <span class="examples-label">没想好？点一条改改：</span>
          <button
            v-for="text in recipe.examples"
            :key="text"
            type="button"
            class="example"
            @click="useExample(text)"
          >{{ text }}</button>
        </div>

        <!--
          把拼好的话原样摆出来。不给看的话，用户按下按钮之前完全不知道
          我们替他说了什么 —— 而那句话会直接决定模型产出什么。
        -->
        <div v-if="ready" class="preview">
          <span class="preview-label">会发出去的是这句：</span>
          <p>{{ preview }}</p>
        </div>
      </div>

      <footer>
        <span class="hint">Ctrl/⌘ + Enter</span>
        <button type="button" class="ghost-btn" @click="closeWizard">取消</button>
        <button type="button" class="primary-btn" :disabled="!ready" @click="submit">
          <AppIcon name="sparkle" :size="14" filled />去创作
        </button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--foreground) 32%, transparent);
}

.wizard {
  display: flex;
  flex-direction: column;
  width: min(620px, 100%);
  max-height: min(88vh, 720px);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--background);
  box-shadow: 0 24px 60px color-mix(in srgb, var(--foreground) 22%, transparent);
  overflow: hidden;
}

header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  padding: 12px 12px 12px 18px;
  border-bottom: 1px solid var(--border);
}
header h2 {
  flex: 1;
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.wiz-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  flex: 1;
  min-height: 0;
  padding: 16px 18px;
  overflow-y: auto;
}

.lead {
  margin: 0;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.7;
}

.kinds {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 7px;
}
.kind {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 11px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease;
}
.kind:hover {
  background: var(--secondary);
  color: var(--foreground);
}
.kind.on {
  border-color: color-mix(in srgb, var(--brand-accent) 55%, var(--border));
  background: color-mix(in srgb, var(--brand-accent) 10%, transparent);
  color: var(--brand-accent);
}
.kind-name {
  font-size: 12px;
  font-weight: 500;
}

.blurb {
  margin: -4px 0 0;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.6;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  font-size: 12.5px;
  font-weight: 600;
}
.field textarea {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
  color: var(--foreground);
  font-size: 13.5px;
  line-height: 1.65;
  resize: vertical;
}
.field textarea:focus {
  outline: none;
  border-color: color-mix(in srgb, var(--brand-accent) 50%, var(--border));
}

.examples {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.examples-label {
  color: var(--muted-foreground);
  font-size: 12px;
}
.example {
  padding: 8px 11px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12.5px;
  line-height: 1.55;
  text-align: left;
  cursor: pointer;
}
.example:hover {
  border-style: solid;
  background: var(--secondary);
  color: var(--foreground);
}

.preview {
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--brand-accent) 8%, transparent);
}
.preview-label {
  color: var(--muted-foreground);
  font-size: 11.5px;
}
.preview p {
  margin: 5px 0 0;
  font-size: 13px;
  line-height: 1.65;
}

footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: 0 0 auto;
  padding: 11px 18px;
  border-top: 1px solid var(--border);
}
.hint {
  margin-right: auto;
  color: var(--muted-foreground);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 600px) {
  .mask {
    padding: 0;
  }
  .wizard {
    max-height: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
  }
}
</style>
