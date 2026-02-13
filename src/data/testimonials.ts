export type Testimonial = {
  name: string;
  role: string;
  company: string;
  avatar: string;
  content: string;
  rating: number;
  project: string;
};

const testimonials: Testimonial[] = [
  {
    name: "Marcus Thompson",
    role: "Owner",
    company: "Thompson's Auto Repair",
    avatar: "/images/testimonials/sarah.svg",
    content: "We needed a way to track appointments and customer info without the chaos of spreadsheets. Brandon built us something that actually works for our shop. Staff picked it up quickly and it's been reliable since day one.",
    rating: 5,
    project: "Business Management App"
  },
  {
    name: "Jennifer Lee",
    role: "Founder",
    company: "Bella Rosa Salon",
    avatar: "/images/testimonials/emily.svg",
    content: "The online booking system Brandon put together has cut down on phone calls significantly. A few clients had minor issues at first, but he fixed those fast. Overall solid work and fair pricing.",
    rating: 4.5,
    project: "Salon Booking System"
  },
  {
    name: "David Okonkwo",
    role: "Managing Director",
    company: "Okonkwo Legal Services",
    avatar: "/images/testimonials/michael.svg",
    content: "Had Brandon build a chatbot to handle basic client inquiries. It's not perfect for complex questions, but it saves our reception staff time on the routine stuff. Good value for what we paid.",
    rating: 5,
    project: "AI Legal Assistant Chatbot"
  },
];

export default testimonials;
