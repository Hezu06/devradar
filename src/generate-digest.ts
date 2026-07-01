import 'dotenv/config';
import {
  generateDailyDigest,
  disconnectDigestService,
} from './services/digest-service';

async function main() {
  console.log('📰 Đang tạo DevRadar Daily Digest...');

  const result = await generateDailyDigest();

  console.log(`✅ Đã tạo digest từ ${result.articleCount} articles.`);
  console.log('');
  console.log(result.digest.title);
  console.log('');
  console.log(result.digest.content);
}

main()
  .catch((error) => {
    console.error('❌ Lỗi tạo digest:', error.message);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectDigestService();
  });