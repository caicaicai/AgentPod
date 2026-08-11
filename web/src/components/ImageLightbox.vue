<script setup>
import { onMounted, ref } from 'vue'

/**
 * 看原图。
 *
 * 用原生 <dialog> 而不是引个灯箱库 —— Esc 关闭、背景遮罩、焦点管理都是白送的。
 * 点任意位置（包括图本身）关掉：这是所有看图界面的共同预期。
 */
defineProps({
  src: { type: String, required: true },
})
const emit = defineEmits(['close'])

const dialog = ref(null)
onMounted(() => dialog.value?.showModal())
</script>

<template>
  <dialog
    ref="dialog"
    class="image-viewer"
    @click="dialog?.close()"
    @close="emit('close')"
    @cancel="emit('close')"
  >
    <img :src="src" alt="查看原图" />
  </dialog>
</template>

<style scoped>
.image-viewer {
  max-width: 94vw;
  max-height: 92vh;
  padding: 0;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  overflow: hidden;
}
.image-viewer::backdrop {
  background: rgb(0 0 0 / 72%);
}
.image-viewer img {
  display: block;
  max-width: 94vw;
  max-height: 92vh;
  border-radius: var(--radius-md);
  cursor: zoom-out;
}
</style>
