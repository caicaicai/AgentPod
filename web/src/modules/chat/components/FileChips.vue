<script setup>
import AppIcon from '@/components/AppIcon.vue'
import { formatBytes } from '../attachments.js'

/**
 * 附件条。
 *
 * 输入框里的待发附件和已发出去那条消息里的附件共用这一个组件 —— 同一个文件在
 * 两种状态下长得一样，用户不用重新认一次。差别只有 `removable`（能不能撤掉）。
 *
 * 图片直接出缩略图而不是也做成 chip：截图本来就是给人看的，缩成一行文件名
 * 等于"带了但看不见"，用户没法确认自己选对了那张。
 */
const props = defineProps({
  files: { type: Array, default: () => [] },
  removable: { type: Boolean, default: false },
})
const emit = defineEmits(['remove', 'preview', 'open'])
</script>

<template>
  <div v-if="props.files.length" class="file-strip">
    <template v-for="file in props.files" :key="file.id || file.name">
      <span v-if="file.kind === 'image' && file.previewUrl" class="file-image">
        <img :src="file.previewUrl" :alt="file.name" @click="emit('preview', file.previewUrl)" />
        <button
          v-if="props.removable"
          type="button"
          class="image-x"
          :title="`移除 ${file.name}`"
          @click.stop="emit('remove', file)"
        >
          <AppIcon name="x" :size="12" />
        </button>
      </span>

      <span v-else class="file-chip" :class="{ inert: !file.text }">
        <!--
          没有正文可看的 chip（历史里那些"没发出去"的）不做成按钮：
          点了弹一个空白预览框，比不能点更让人困惑。
        -->
        <component
          :is="file.text ? 'button' : 'span'"
          :type="file.text ? 'button' : undefined"
          class="chip-open"
          :title="file.name"
          @click="file.text && emit('open', file)"
        >
          <AppIcon :name="file.kind === 'image' ? 'image' : 'file'" :size="14" class="chip-icon" />
          <span class="chip-name">{{ file.name }}</span>
        </component>
        <!-- 「未发送」这类说明比一个 0B 有用得多，有它就顶掉体积 -->
        <small>{{ file.note || formatBytes(file.size) }}</small>
        <button
          v-if="props.removable"
          type="button"
          class="chip-x"
          :title="`移除 ${file.name}`"
          @click="emit('remove', file)"
        >
          <AppIcon name="x" :size="12" />
        </button>
      </span>
    </template>
  </div>
</template>

<style scoped>
.file-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.file-chip.inert {
  border-style: dashed;
}
.file-chip.inert .chip-open {
  cursor: default;
}
.image-x {
  position: absolute;
  top: 4px;
  right: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  /* 缩略图底下什么颜色都可能，所以这颗按钮自带不透明底，不跟随主题 */
  background: rgb(0 0 0 / 55%);
  color: #fff;
  cursor: pointer;
}
.image-x:hover {
  background: rgb(0 0 0 / 75%);
}
</style>
